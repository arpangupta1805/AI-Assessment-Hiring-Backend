import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import SkillName from '../models/skills.js';
import JobDescription from '../models/JobDescription.js';
import Resume from '../models/Resume.js';
import QuestionBank from '../models/QuestionBank.js';
import interview from '../models/interview.js';
import interviews from '../models/interviews.js';
import candidateansbank from '../models/candidateAnsbank.js';
import ExamSession from '../models/ExamSession.js';
import feedbackinterview from '../models/feedbackofinterview.js';
import FollowUpQuestion from '../models/FollowUpQuestion.js';
import InterviewMetadata from '../models/InterviewMetadata.js';
import { detectFollowUpNeed, generateFollowUpQuestion, checkFollowUpHeuristics, extractFirstBalancedJSON } from '../services/followUpService.js';

const router = express.Router();

// Token estimation helper (rough heuristic): 1 token ≈ 4 characters
const estimateTokens = (text) => {
  if (!text) return 0;
  // use approximate 4 chars per token heuristic
  return Math.max(1, Math.ceil(text.length / 4));
};

// Cost rates per 1K tokens (examples, update to match your billing):
// These are rough example rates. Replace with actual model pricing as needed.
const MODEL_RATES_PER_1K = {
  'gemini-2.0': { input: 0.00125, output: 0.01 }, // $ per 1K tokens (example)
  'gemini-2.0-flash': { input: 0.00025, output: 0.02 },
};

// Helper function to call Gemini API with retry logic and exponential backoff
// This wrapper also logs an estimated token consumption and approximate cost per call
const callGeminiWithRetry = async (prompt, maxRetries = 3) => {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  // Estimate prompt tokens
  const promptText = String(prompt || '');
  const promptTokens = estimateTokens(promptText);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
        }),
      });

      // Handle rate limiting (429)
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 5000;
        console.log(`⚠️  Rate limited (429). Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        } else {
          throw new Error('Gemini API rate limit exceeded. Please try again later.');
        }
      }

      // Handle service overload (503)
      if (response.status === 503) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.log(`⚠️  Service overloaded (503). Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        } else {
          throw new Error('Gemini API service is overloaded. Please try again later.');
        }
      }

      // Handle other HTTP errors
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorText}`);
      }

      const json = await response.json();

      // Estimate response tokens from returned text (best-effort)
      const responseText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const responseTokens = estimateTokens(responseText);

      const rates = MODEL_RATES_PER_1K[model] || MODEL_RATES_PER_1K['gemini-2.0-flash'];
      const inputCost = (promptTokens / 1000) * rates.input;
      const outputCost = (responseTokens / 1000) * rates.output;
      const callCost = inputCost + outputCost;

      console.log(`🧾 Gemini call (${model}) tokens — prompt: ${promptTokens}, response: ${responseTokens}, total: ${promptTokens + responseTokens}. Approx cost: $${callCost.toFixed(6)}`);

      return json;
    } catch (error) {
      if (attempt === maxRetries - 1 || error.message.includes('rate limit')) {
        throw error;
      }
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`⚠️  Gemini API error: ${error.message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Helper wrapper that asks Gemini to return STRICT JSON and will retry asking the model
// to reformat its previous output if parsing fails. Uses extractFirstBalancedJSON to
// robustly pull JSON from noisy text, then requests a reformat if needed.
const callGeminiJSON = async (prompt, exampleJsonString = null, maxCalls = 3) => {
  // maxCalls limits the TOTAL number of calls to Gemini (initial + any reformat attempts).
  // This guarantees we never loop indefinitely. Default = 3 calls total.
  let callsMade = 0;
  let lastText = '';

  while (callsMade < maxCalls) {
    // 1) Make a normal call
    try {
  callsMade++;
  const resp = await callGeminiWithRetry(prompt, 1);
  lastText = resp?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (!lastText || /202|still being generated|partial data/i.test(lastText)) {
        throw new Error('Model returned partial or empty response');
      }

      const extracted = extractFirstBalancedJSON(lastText);
      if (extracted) {
        try {
          const parsed = typeof extracted === 'string' ? JSON.parse(extracted) : extracted;
          return parsed;
        } catch (parseError) {
          console.warn('⚠️  Extracted JSON could not be parsed:', parseError.message);
          // continue to possible reformat (if calls left)
        }
      } else {
        console.warn('⚠️  No balanced JSON found in model response');
      }
    } catch (err) {
      console.warn(`⚠️  callGeminiJSON call #${callsMade} failed: ${err.message}`);
    }

    // 2) If we still have budget for calls, ask the model to reformat the previous output
    if (callsMade < maxCalls) {
      const reformatInstruction = `The previous response was not valid JSON. You must now reformat the previous output into a single, valid JSON object and return ONLY that JSON object (no explanation, no markdown, no code fences).` +
        (exampleJsonString ? ` The required JSON schema/example is:\n${exampleJsonString}` : '') +
        `\n\nHere is the previous model output:\n"""\n${lastText}\n"""\n\nReturn only the JSON object.`;

      try {
        callsMade++;
        const retryResp = await callGeminiWithRetry(reformatInstruction, 1);
        const retryText = retryResp?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const retryExtracted = extractFirstBalancedJSON(retryText);
        if (retryExtracted) {
          try {
            const parsedRetry = typeof retryExtracted === 'string' ? JSON.parse(retryExtracted) : retryExtracted;
            return parsedRetry;
          } catch (e) {
            console.warn('⚠️  Retried JSON still failed to parse:', e.message);
            lastText = retryText;
            // loop will continue if calls remain
          }
        } else {
          console.warn('⚠️  Reformat attempt did not produce balanced JSON');
          lastText = retryText;
        }
      } catch (retryErr) {
        console.warn('⚠️  Reformat retry call failed:', retryErr.message);
      }
    }
  }

  console.error('❌ callGeminiJSON: failed to obtain valid JSON after maxCalls=', maxCalls);
  return null;
};

// Helper function to get difficulty level key for skills model
// Helper function to map difficulty level to question bank array field
// Frontend sends: 'Basic', 'Medium', 'Hard', 'Expert'
// Maps to 3 database tiers: Easy (Basic), Medium, Hard (Hard+Expert)
const getDifficultyKey = (level) => {
  const levelMap = {
    'Basic': 'arrofeasyquestionbankids',
    'Easy': 'arrofeasyquestionbankids',      // Legacy support
    'Medium': 'arrofoMediumquestionbankids',
    'Hard': 'arrofoHardquestionbankids',
    'Expert': 'arrofoHardquestionbankids',
  };
  return levelMap[level] || 'arrofoMediumquestionbankids';
};

// Helper function to normalize difficulty level for database storage
// Consolidates frontend 4-tier system (Basic, Medium, Hard, Expert)
// into 3-tier database system (Easy, Medium, Hard)
const normalizeDifficultyLevel = (level) => {
  const levelMap = {
    'Basic': 'Easy',      // Beginner level → Easy tier
    'Easy': 'Easy',       // Legacy support
    'Medium': 'Medium',   // Direct mapping
    'Hard': 'Hard',       // Direct mapping
    'Expert': 'Hard',     // Advanced level → Hard tier
  };
  return levelMap[level] || 'Medium';
};

// Function to calculate number of questions based on duration
const getQuestionCount = (duration) => {
  // Extract number from duration string (e.g., "3 mins" -> "3")
  const durationNumber = duration?.toString().split(' ')[0] || duration;
  
  // Use min value from getQuestionLimits for base question generation
  const durationMap = {
    '3': 2,   // min for 3 min interview
    '5': 4,   // min for 5 min interview
    '20': 10, // min for 20 min interview
  };
  
  const questionCount = durationMap[durationNumber] || 5; // Default to 5 if duration not found
  console.log(`📊 Duration: "${duration}" -> Number: "${durationNumber}" -> Base Questions: ${questionCount}`);
  return questionCount;
};

// Function to get min/max question counts for dynamic interview (Phase 2)
const getQuestionLimits = (duration) => {
  // Extract number from duration string (e.g., "3 mins" -> "3")
  const durationNumber = duration?.toString().split(' ')[0] || duration;
  
  const limitsMap = {
    '3': { min: 2, max: 6 },    // 3 min interview: 2-6 questions
    '5': { min: 4, max: 10 },   // 5 min interview: 4-10 questions
    '20': { min: 10, max: 16 }, // 20 min interview: 10-16 questions
  };
  
  const limits = limitsMap[durationNumber] || { min: 5, max: 20 };
  console.log(`📊 Duration limits: "${duration}" -> min=${limits.min}, max=${limits.max}`);
  return limits;
};

// POST /api/interview/start - Start an interview (get/generate questions)
// Supports skill-based, JD-based, and resume-based interviews
router.post('/start', authenticateToken, async (req, res) => {
  try {
    const { skillName, jdId, jdText, jdTitle, resumeId, resumeText, resumeTitle, level, description, duration } = req.body;
    
    // Debug: Check if user is authenticated
    if (!req.user) {
      console.error('❌ No user object in request - authentication failed');
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
      });
    }
    
    const username = req.user.username;
    
    if (!username) {
      console.error('❌ Username not found in user object:', req.user);
      return res.status(401).json({
        success: false,
        error: 'Username not found in authentication token',
      });
    }

    // Determine interview type
    const isJdInterview = jdId || jdText;
    const isSkillInterview = skillName;
    const isResumeInterview = resumeId || resumeText;

    // Validation - exactly one type must be specified
    const interviewTypesCount = (isJdInterview ? 1 : 0) + (isSkillInterview ? 1 : 0) + (isResumeInterview ? 1 : 0);
    
    if (interviewTypesCount === 0) {
      return res.status(400).json({
        success: false,
        error: 'Either skill name, job description, or resume is required',
      });
    }

    if (interviewTypesCount > 1) {
      return res.status(400).json({
        success: false,
        error: 'Cannot start interview with multiple types simultaneously',
      });
    }

    if (!level) {
      return res.status(400).json({
        success: false,
        error: 'Difficulty level is required',
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('🎯 STARTING INTERVIEW');
    console.log('='.repeat(80));
    console.log('Username:', username);
    console.log('Type:', isJdInterview ? 'JD-Based' : isResumeInterview ? 'Resume-Based' : 'Skill-Based');
    console.log('Level:', level);
    console.log('Description:', description || 'None');
    console.log('-'.repeat(80));

    // REMOVED: The duplicate interview check was too aggressive
    // It was preventing users from starting new interviews for the same skill
    // Users should be able to start a new interview even if they recently completed one

    let skill = null;
    let jd = null;
    let resume = null;
    let interviewName = '';
    let interviewDescription = '';

    // Handle resume-based interview
    if (isResumeInterview) {
      // If resumeId is provided, fetch existing resume
      if (resumeId) {
        resume = await Resume.findById(resumeId);
        if (!resume) {
          return res.status(404).json({
            success: false,
            error: 'Resume not found',
          });
        }
        // Verify ownership
        if (resume.username !== username) {
          return res.status(403).json({
            success: false,
            error: 'Access denied to this resume',
          });
        }
        console.log('✅ Using existing Resume:', resume.title);
      } else if (resumeText) {
        // resumeTitle must be provided from frontend; validate server-side too
        if (!resumeTitle || !resumeTitle.trim()) {
          return res.status(400).json({
            success: false,
            error: 'Resume title is required for resume-based interviews',
          });
        }

        // Validate resume text length
        const trimmedResumeText = resumeText.trim();
        if (!trimmedResumeText || trimmedResumeText.length < 50) {
          return res.status(400).json({
            success: false,
            error: 'Resume text must be at least 50 characters long',
          });
        }

        // Append suffix ' (Resume)' if not already present
        let storedTitle = resumeTitle.trim();
        if (!storedTitle.endsWith(' (Resume)')) {
          storedTitle = `${storedTitle} (Resume)`;
        }

        // Create new resume from text
        resume = await Resume.create({
          username,
          title: storedTitle,
          resumeText: trimmedResumeText,
          arrofQuestionbankids: new Map([
            ['arrofeasyquestionbankids', []],
            ['arrofoMediumquestionbankids', []],
            ['arrofoHardquestionbankids', []],
            ['arrofoExpertquestionbankids', []],
          ]),
        });
        console.log(`✅ Created new Resume (ID: ${resume._id})`);
      }

      interviewName = resume.title;
      interviewDescription = resume.resumeText;
    }
    // Handle JD-based interview
    else if (isJdInterview) {
      // If jdId is provided, fetch existing JD
      if (jdId) {
        jd = await JobDescription.findById(jdId);
        if (!jd) {
          return res.status(404).json({
            success: false,
            error: 'Job description not found',
          });
        }
        // Verify ownership
        if (jd.username !== username) {
          return res.status(403).json({
            success: false,
            error: 'Access denied to this job description',
          });
        }
        console.log('✅ Using existing JD:', jd.title);
      } else if (jdText) {
        // jdTitle must be provided from frontend; validate server-side too
        if (!jdTitle || !jdTitle.trim()) {
          return res.status(400).json({
            success: false,
            error: 'Job title is required for JD-based interviews',
          });
        }

        // Validate JD text length
        const trimmedJDText = jdText.trim();
        if (!trimmedJDText || trimmedJDText.length < 50) {
          return res.status(400).json({
            success: false,
            error: 'Job description must be at least 50 characters long',
          });
        }

        // Append suffix ' (Role)' if not already present
        let storedTitle = jdTitle.trim();
        if (!storedTitle.endsWith(' (Role)')) {
          storedTitle = `${storedTitle} (Role)`;
        }

        // Create new JD from text
        jd = await JobDescription.create({
          username,
          title: storedTitle,
          jdText: trimmedJDText,
          arrofQuestionbankids: new Map([
            ['arrofeasyquestionbankids', []],
            ['arrofoMediumquestionbankids', []],
            ['arrofoHardquestionbankids', []],
            ['arrofoExpertquestionbankids', []],
          ]),
        });
        console.log(`✅ Created new JD (ID: ${jd._id})`);
      }

      interviewName = jd.title;
      interviewDescription = jd.jdText;
    } 
    // Handle skill-based interview
    else {
      const escapedSkillName = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      skill = await SkillName.findOne({ 
        name: { $regex: new RegExp(`^${escapedSkillName}$`, 'i') } 
      });

      console.log('🔍 Searching for skill:', skillName);

      if (!skill) {
        console.log('❌ Skill not found in database');
        return res.status(404).json({
          success: false,
          error: 'Skill not found. Please create the skill first with a description.',
        });
      }

      console.log('✅ Skill found:', skill.name);
      interviewName = skill.name;
      interviewDescription = skill.description;
    }

    const normalizedLevel = normalizeDifficultyLevel(level);
    const difficultyKey = getDifficultyKey(level);

    // Find or create public interview record
    let publicInterview = await interview.findOne(
      isJdInterview 
        ? { jdid: jd._id.toString(), difflevel: normalizedLevel }
        : isResumeInterview
        ? { resumeid: resume._id.toString(), difflevel: normalizedLevel }
        : { skillid: skill._id.toString(), difflevel: normalizedLevel }
    );

    if (!publicInterview) {
      publicInterview = await interview.create(
        isJdInterview
          ? {
              jdid: jd._id.toString(),
              difflevel: normalizedLevel,
              count: 0,
              ArrofQuestionbankids: [],
            }
          : isResumeInterview
          ? {
              resumeid: resume._id.toString(),
              difflevel: normalizedLevel,
              count: 0,
              ArrofQuestionbankids: [],
            }
          : {
              skillid: skill._id.toString(),
              difflevel: normalizedLevel,
              count: 0,
              ArrofQuestionbankids: [],
            }
      );
      console.log('✅ Created new public interview record');
    }

    const currentCount = publicInterview.count + 1;
    console.log(`📊 Interview Count: ${currentCount}`);

    // Always generate new questions from AI (no reuse of existing question banks)
    console.log('🤖 Generating new questions with AI...');
    let questionBank = null;
    
    // Calculate number of questions based on duration
    const questionCount = getQuestionCount(duration);
    
    // Generate questions using Gemini API
    let prompt;
    
    if (isJdInterview) {
      prompt = `You are an expert technical interviewer. Generate ${questionCount} subjective interview questions for a mock interview based on the following job description:

**Job Description**:
${interviewDescription}

**Difficulty Level**: ${level}
${description ? `**Additional Instructions**: ${description}` : ''}

CREATE ${questionCount} interview questions tailored to this job description at a ${level} difficulty level.
For each question:
1. Create a clear, specific, and relevant interview question based on the job requirements
2. Provide a concise answer (4-5 lines maximum)
3. Ensure questions are appropriate for the ${level} difficulty level
4. Cover different aspects mentioned in the JD (technical skills, experience, responsibilities, soft skills)

Format the response as a JSON array with exactly ${questionCount} objects, each containing:
- "questionNumber": (number from 1 to ${questionCount})
- "question": (the interview question)
- "answer": (concise answer in 4-5 lines)

Return ONLY the JSON array, no additional text or markdown formatting.`;
    } else if (isResumeInterview) {
      prompt = `You are an expert technical interviewer. Generate ${questionCount} subjective interview questions for a mock interview based on the following resume:

**Resume**:
${interviewDescription}

**Difficulty Level**: ${level}
**Role**: ${interviewName}
${description ? `**Additional Instructions**: ${description}` : ''}

CREATE ${questionCount} interview questions tailored to this resume at a ${level} difficulty level.
For each question:
1. Create a clear, specific, and relevant interview question based on the candidate's background
2. Provide a concise answer (4-5 lines maximum)
3. Ensure questions are appropriate for the ${level} difficulty level
4. Cover different aspects of the resume (experience, skills, achievements, projects, education)

Format the response as a JSON array with exactly ${questionCount} objects, each containing:
- "questionNumber": (number from 1 to ${questionCount})
- "question": (the interview question)
- "answer": (concise answer in 4-5 lines)

Return ONLY the JSON array, no additional text or markdown formatting.`;
    } else {
      prompt = `You are an expert technical interviewer. Generate ${questionCount} subjective interview questions for a mock interview with the following specifications:

**Skill**: ${interviewName}
**Difficulty Level**: ${level}
**Skill Description**: ${interviewDescription}
${description ? `**Additional Instructions**: ${description}` : ''}

CREATE ${questionCount} interview questions related to ${interviewName} at a ${level} difficulty level.
For each question:
1. Create a clear, specific, and relevant interview question
2. Provide a concise answer (4-5 lines maximum)
3. Ensure questions are appropriate for the ${level} difficulty level
4. Cover different aspects of ${interviewName} (concepts, practical application, problem-solving, best practices)

Format the response as a JSON array with exactly ${questionCount} objects, each containing:
- "questionNumber": (number from 1 to ${questionCount})
- "question": (the interview question)
- "answer": (concise answer in 4-5 lines)

Return ONLY the JSON array, no additional text or markdown formatting.`;
    }

    const data = await callGeminiWithRetry(prompt);
    const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    console.log('🤖 AI Response received');

    // Parse AI response
    let questionsData;
    try {
      questionsData = JSON.parse(aiResponse);
    } catch (e) {
      const arrayMatch = aiResponse.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        questionsData = JSON.parse(arrayMatch[0]);
      } else {
        throw new Error('Failed to parse AI response');
      }
    }

    // Extract questions and answers
    const questions = questionsData.map(q => q.question);
    const expectedAnswers = questionsData.map(q => q.answer);

    // Create new question bank
    questionBank = await QuestionBank.create(
      isJdInterview
        ? {
            questionarr: questions,
            expectedansarr: expectedAnswers,
            difficultylevel: normalizedLevel,
            jdid: jd._id.toString(),
          }
        : isResumeInterview
        ? {
            questionarr: questions,
            expectedansarr: expectedAnswers,
            difficultylevel: normalizedLevel,
            resumeid: resume._id.toString(),
          }
        : {
            questionarr: questions,
            expectedansarr: expectedAnswers,
            difficultylevel: normalizedLevel,
            skillid: skill._id.toString(),
          }
    );

    console.log(`✅ Created new question bank (ID: ${questionBank._id})`);

    // Update public interview record
    publicInterview.ArrofQuestionbankids.push(questionBank._id.toString());
    publicInterview.count = currentCount;
    await publicInterview.save();

    // Update skill's, JD's, or Resume's question bank array
    if (isJdInterview) {
      const questionBankIdsInJD = jd.arrofQuestionbankids.get(difficultyKey) || [];
      questionBankIdsInJD.push(questionBank._id.toString());
      jd.arrofQuestionbankids.set(difficultyKey, questionBankIdsInJD);
      await jd.save();
    } else if (isResumeInterview) {
      const questionBankIdsInResume = resume.arrofQuestionbankids.get(difficultyKey) || [];
      questionBankIdsInResume.push(questionBank._id.toString());
      resume.arrofQuestionbankids.set(difficultyKey, questionBankIdsInResume);
      await resume.save();
    } else {
      const questionBankIdsInSkill = skill.arrofQuestionbankids.get(difficultyKey) || [];
      questionBankIdsInSkill.push(questionBank._id.toString());
      skill.arrofQuestionbankids.set(difficultyKey, questionBankIdsInSkill);
      await skill.save();
    }

    console.log('✅ Updated public interview and parent records');

    // Create or update user's private interview record
    let userInterviews = await interviews.findOne({ username });
    
    if (!userInterviews) {
      try {
        userInterviews = await interviews.create({
          username,
          Arrofskillids: isSkillInterview ? [skill._id.toString()] : [],
          ArrofInterview: [publicInterview._id.toString()],
          ArrofCandidatebankids: [],
          Arrofinterviewfeedbackids: [],
        });
        console.log('✅ Created new user interviews document');
      } catch (err) {
        console.log('⚠️ Error creating interviews document, trying to find existing:', err.message);
        userInterviews = await interviews.findOne({ username });
        if (!userInterviews) {
          console.log('❌ Could not create or find interviews document, continuing without it');
        }
      }
    }
    
    if (userInterviews) {
      // Add skill if skill-based interview and not already present
      if (isSkillInterview && !userInterviews.Arrofskillids.includes(skill._id.toString())) {
        userInterviews.Arrofskillids.push(skill._id.toString());
      }
      // Add interview if not already present
      if (!userInterviews.ArrofInterview.includes(publicInterview._id.toString())) {
        userInterviews.ArrofInterview.push(publicInterview._id.toString());
      }
      try {
        await userInterviews.save();
        console.log('✅ Updated user interviews record');
      } catch (err) {
        console.log('⚠️ Error updating user interviews record:', err.message);
      }
    }

    // Create a candidate answer draft so the frontend can redirect immediately
    let candidateDraft = null;
    try {
      const emptyAnswers = new Array((questionBank.questionarr || []).length).fill('');
      candidateDraft = await candidateansbank.create({
        cout: emptyAnswers.length,
        Questionbankid: questionBank._id.toString(),
        username: username,
        ansArray: emptyAnswers,
        Feedbackdict: new Map([
          ['Areaofimprovement', []],
          ['whatwentwell', []],
          ['overallcomments', []],
        ]),
      });
      console.log(`✅ Created candidate answer draft (ID: ${candidateDraft._id})`);
    } catch (e) {
      console.warn('⚠️  Failed to create candidate draft:', e.message);
    }

    // Create an exam session record to track start_time and pings
    let examSession = null;
    try {
      examSession = await ExamSession.create({
        username: username,
        questionBankId: questionBank._id.toString(),
        candidateAnsBankId: candidateDraft?._id || null,
        start_time: new Date(),
        last_ping: new Date(),
        status: 'active',
      });
      console.log(`✅ Created exam session (ID: ${examSession._id})`);
    } catch (e) {
      console.warn('⚠️  Failed to create exam session:', e.message);
    }

    // PHASE 2: Create interview metadata for follow-up question management
    let interviewMetadata = null;
    try {
      const limits = getQuestionLimits(duration);
      const baseQuestionCount = questionBank.questionarr.length;
      
      interviewMetadata = await InterviewMetadata.create({
        username: username,
        candidateAnsBankId: candidateDraft._id.toString(),
        interviewId: publicInterview._id.toString(),
        questionBankId: questionBank._id.toString(),
        duration: duration || '5 mins',
        minQuestions: limits.min,
        maxQuestions: limits.max,
        baseQuestionCount: baseQuestionCount,
        currentTotalQuestions: baseQuestionCount,
        followupCount: 0,
        totalQuestionsAnswered: 0,
        lastFollowupPosition: -1,
        cooldownBlockedPositions: [],
        avgDetectorConfidence: 0,
        detectorCallCount: 0,
        followupApprovalCount: 0,
        followupRejectionCount: 0,
        status: 'active',
      });
      console.log(`✅ Created interview metadata (ID: ${interviewMetadata._id}), min=${limits.min}, max=${limits.max}`);
    } catch (e) {
      console.warn('⚠️  Failed to create interview metadata:', e.message);
    }

    console.log('✅ Interview started successfully');
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      message: 'Interview started successfully',
      data: {
        interviewId: publicInterview._id,
        questionBankId: questionBank._id,
        examSessionId: examSession?._id || null,
        candidateAnsBankId: candidateDraft?._id || null,
        ...(isSkillInterview ? { skillId: skill._id, skillName: skill.name } : {}),
        ...(isJdInterview ? { jdId: jd._id, jdTitle: jd.title } : {}),
        ...(isResumeInterview ? { resumeId: resume._id, resumeTitle: resume.title } : {}),
        interviewType: isJdInterview ? 'jd' : isResumeInterview ? 'resume' : 'skill',
        level: normalizedLevel,
        count: currentCount,
        questions: questionBank.questionarr,
        totalQuestions: questionBank.questionarr.length,
        // Phase 2: Dynamic question count info
        minQuestions: interviewMetadata?.minQuestions || questionBank.questionarr.length,
        maxQuestions: interviewMetadata?.maxQuestions || questionBank.questionarr.length,
        isDynamic: true, // Flag to indicate dynamic question count
      },
    });
  } catch (error) {
    console.error('❌ Error starting interview:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start interview',
      message: error.message,
    });
  }
});

// POST /api/interview/submit - Submit interview answers
router.post('/submit', authenticateToken, async (req, res) => {
  try {
    const { questionBankId, answers, candidateAnsBankId } = req.body;
    const username = req.user.username;

    // Validation
    if (!questionBankId || !answers || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        error: 'Question bank ID and answers array are required',
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('📝 SUBMITTING INTERVIEW ANSWERS');
    console.log('='.repeat(80));
    console.log('Username:', username);
    console.log('Question Bank ID:', questionBankId);
    console.log('Number of answers:', answers.length);
    console.log('-'.repeat(80));

    // PHASE 0: Check if already submitted to prevent duplicate submissions
    if (candidateAnsBankId) {
      const metadata = await InterviewMetadata.findOne({ candidateAnsBankId });
      if (metadata && (metadata.status === 'submitted' || metadata.status === 'generating_feedback' || metadata.status === 'completed')) {
        console.log(`⚠️  Interview already submitted (status: ${metadata.status}). Returning success without re-processing.`);
        return res.json({
          success: true,
          message: 'Interview already submitted',
          data: {
            candidateAnsBankId: candidateAnsBankId,
            submittedAnswers: answers.length,
            alreadySubmitted: true,
          },
        });
      }
    }

    // Find question bank
    const questionBank = await QuestionBank.findById(questionBankId);
    
    if (!questionBank) {
      return res.status(404).json({
        success: false,
        error: 'Question bank not found',
      });
    }

    // If frontend provided a candidateAnsBankId (draft), update it; otherwise create new
    let candidateAns = null;
    if (candidateAnsBankId) {
      candidateAns = await candidateansbank.findById(candidateAnsBankId);
      if (candidateAns) {
        candidateAns.ansArray = answers;
        candidateAns.cout = answers.length;
        await candidateAns.save();
        console.log(`✅ Updated candidate answer bank (ID: ${candidateAns._id})`);
      }
    }

    if (!candidateAns) {
      candidateAns = await candidateansbank.create({
        cout: answers.length,
        Questionbankid: questionBankId,
        username: username,
        ansArray: answers,
        Feedbackdict: new Map([
          ['Areaofimprovement', []],
          ['whatwentwell', []],
          ['overallcomments', []],
        ]),
      });

      console.log(`✅ Created candidate answer bank (ID: ${candidateAns._id})`);
    }

    // Update user's interviews document
    const userInterviews = await interviews.findOne({ username });
    
    if (userInterviews) {
      try {
        userInterviews.ArrofCandidatebankids.push(candidateAns._id.toString());
        await userInterviews.save();
        console.log('✅ Updated user interviews record');
      } catch (err) {
        console.log('⚠️ Error updating user interviews record:', err.message);
        // Continue even if update fails
      }
    } else {
      console.log('⚠️ User interviews document not found, continuing without update');
    }

    // PHASE 2: Mark interview metadata as submitted and save follow-up answers
    try {
      const metadata = await InterviewMetadata.findOne({ candidateAnsBankId: candidateAns._id.toString() });
      if (metadata) {
        metadata.status = 'submitted';
        await metadata.save();
        console.log('✅ Marked interview metadata as submitted');
      }

      // Update follow-up questions with candidate answers
      // The answers array may contain answers to follow-up questions as per display order
      // We need to compute each follow-up's display index (position in the interview sequence)
      const followUps = await FollowUpQuestion.find({
        candidateAnsBankId: candidateAns._id.toString(),
      }).sort({ questionNumber: 1 });

      if (followUps.length > 0) {
        // Recreate the combined question ordering used during the interview
        const combined = [];
        for (let i = 0; i < questionBank.questionarr.length; i++) {
          combined.push({ sortKey: i * 1000, isFollowUp: false, baseIndex: i });
        }
        for (const fu of followUps) {
          combined.push({ sortKey: fu.questionNumber, isFollowUp: true, followUpId: fu._id.toString() });
        }
        combined.sort((a, b) => a.sortKey - b.sortKey);

        // Assign display indices and build a map from followUpId -> displayIndex
        const followUpDisplayIndex = {};
        combined.forEach((item, idx) => {
          if (item.isFollowUp) followUpDisplayIndex[item.followUpId] = idx;
        });

        // Now update each follow-up with the answer at its display index
        for (const followUp of followUps) {
          const displayIdx = followUpDisplayIndex[followUp._id.toString()];
          if (displayIdx !== undefined && answers[displayIdx]) {
            followUp.candidateAnswer = answers[displayIdx];
            followUp.status = 'used';
            await followUp.save();
          }
        }
      }
      
      if (followUps.length > 0) {
        console.log(`✅ Updated ${followUps.length} follow-up question answers`);
      }
    } catch (e) {
      console.warn('⚠️  Error updating interview metadata/follow-ups:', e.message);
    }

    console.log('✅ Interview submission completed');
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      message: 'Answers submitted successfully',
      data: {
        candidateAnsBankId: candidateAns._id,
        submittedAnswers: answers.length,
      },
    });
  } catch (error) {
    console.error('❌ Error submitting answers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit answers',
      message: error.message,
    });
  }
});

// POST /api/interview/generate-feedback - Generate feedback for interview
router.post('/generate-feedback', authenticateToken, async (req, res) => {
  try {
    const { candidateAnsBankId } = req.body;
    const username = req.user.username;

    // Validation
    if (!candidateAnsBankId) {
      return res.status(400).json({
        success: false,
        error: 'Candidate answer bank ID is required',
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('🤖 GENERATING FEEDBACK');
    console.log('='.repeat(80));
    console.log('Username:', username);
    console.log('Candidate Answer Bank ID:', candidateAnsBankId);
    console.log('-'.repeat(80));

    // CRITICAL: Check if feedback already exists or is being generated to prevent duplicates
    const existingFeedback = await feedbackinterview.findOne({ candidateAnsBankId });
    if (existingFeedback) {
      console.log('⚠️  Feedback already exists for this interview. Returning existing feedback.');
      return res.json({
        success: true,
        message: 'Feedback already generated',
        data: {
          candidateAnsBankId: candidateAnsBankId,
          feedbackId: existingFeedback._id,
          alreadyGenerated: true,
        },
      });
    }

    // Check if feedback is currently being generated
    const metadata = await InterviewMetadata.findOne({ candidateAnsBankId });
    if (metadata && metadata.status === 'generating_feedback') {
      console.log('⚠️  Feedback is already being generated for this interview. Rejecting duplicate request.');
      return res.status(409).json({
        success: false,
        error: 'Feedback generation already in progress',
        message: 'Please wait for the current feedback generation to complete',
      });
    }

    // Find candidate answer bank
    const candidateAns = await candidateansbank.findById(candidateAnsBankId);
    
    if (!candidateAns) {
      return res.status(404).json({
        success: false,
        error: 'Candidate answer bank not found',
      });
    }

    // Verify ownership
    if (candidateAns.username !== username) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    // Find question bank
    const questionBank = await QuestionBank.findById(candidateAns.Questionbankid);
    
    if (!questionBank) {
      return res.status(404).json({
        success: false,
        error: 'Question bank not found',
      });
    }

    console.log('📝 Generating question-specific feedback...');

    // Set feedback generation status
    if (metadata) {
      metadata.status = 'generating_feedback';
      await metadata.save();
      console.log('📊 Set interview metadata status to generating_feedback');
    }

    const questions = questionBank.questionarr;
    const expectedAnswers = questionBank.expectedansarr;
    const userAnswers = candidateAns.ansArray;
    
    // Get summarized answers (use original if not available)
    const summarizedAnswers = candidateAns.summarizedAnsArray || [];
    const useSummarizedAnswers = summarizedAnswers.length > 0;
    
    if (useSummarizedAnswers) {
      console.log('✅ Using summarized answers for feedback generation');
    } else {
      console.log('⚠️  No summarized answers found, using original answers');
    }

    // PHASE 2: Get follow-up questions for this interview
    const followUpQuestions = await FollowUpQuestion.find({
      candidateAnsBankId: candidateAnsBankId,
    }).sort({ questionNumber: 1 });

    console.log(`📊 Found ${followUpQuestions.length} follow-up questions for feedback generation`);

    // Build combined list of questions for feedback (base + follow-ups)
    const allQuestionsForFeedback = [];

    // Add base questions (use summarized answers for feedback if available)
    for (let i = 0; i < questions.length; i++) {
      const answerForFeedback = useSummarizedAnswers && summarizedAnswers[i]
        ? summarizedAnswers[i]
        : (userAnswers[i] || 'No answer provided');

      allQuestionsForFeedback.push({
        questionNumber: i,
        displayNumber: allQuestionsForFeedback.length + 1,
        question: questions[i],
        expectedAnswer: expectedAnswers[i],
        userAnswer: answerForFeedback,
        isFollowUp: false,
      });
    }

    // Add follow-up questions (use summarized answers for follow-ups too if available)
    for (const followUp of followUpQuestions) {
      const followUpAnswer = followUp.candidateAnswer || userAnswers[followUp.questionNumber] || 'No answer provided';
      const answerForFeedback = useSummarizedAnswers && summarizedAnswers[followUp.questionNumber]
        ? summarizedAnswers[followUp.questionNumber]
        : followUpAnswer;

      allQuestionsForFeedback.push({
        questionNumber: followUp.questionNumber,
        displayNumber: allQuestionsForFeedback.length + 1,
        question: followUp.generatedQuestionText,
        expectedAnswer: followUp.expectedAnswerText,
        userAnswer: answerForFeedback,
        isFollowUp: true,
        originQuestionNumber: followUp.originQuestionNumber,
      });
    }

    // Sort by actual question number to maintain interview flow
    allQuestionsForFeedback.sort((a, b) => a.questionNumber - b.questionNumber);

    // Re-assign display numbers after sorting
    for (let i = 0; i < allQuestionsForFeedback.length; i++) {
      allQuestionsForFeedback[i].displayNumber = i + 1;
    }

    // Aggregate visual data per question for feedback
    const visualDataByQuestion = {};
    
    if (candidateAns.visualDataArray && candidateAns.visualDataArray.length > 0) {
      console.log(`📹 Processing ${candidateAns.visualDataArray.length} visual snapshots for feedback`);
      
      // Group visual data by question number
      for (const snapshot of candidateAns.visualDataArray) {
        const qNum = snapshot.questionNumber;
        if (!visualDataByQuestion[qNum]) {
          visualDataByQuestion[qNum] = [];
        }
        visualDataByQuestion[qNum].push(snapshot);
      }
      
      // Calculate aggregates for each question
      for (const qNum in visualDataByQuestion) {
        const snapshots = visualDataByQuestion[qNum];
        const focusedCount = snapshots.filter(s => s.isFocused).length;
        const focusPercentage = (focusedCount / snapshots.length) * 100;
        
        // Calculate dominant expression
        const expressionCounts = {};
        for (const s of snapshots) {
          expressionCounts[s.expression] = (expressionCounts[s.expression] || 0) + 1;
        }
        const dominantExpression = Object.entries(expressionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'NEUTRAL';
        
        // Calculate gaze distribution
        const gazeCounts = {};
        for (const s of snapshots) {
          gazeCounts[s.gazeDirection] = (gazeCounts[s.gazeDirection] || 0) + 1;
        }
        const dominantGaze = Object.entries(gazeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'CENTER';
        
        visualDataByQuestion[qNum] = {
          totalSnapshots: snapshots.length,
          focusPercentage: focusPercentage.toFixed(1),
          dominantExpression,
          dominantGaze,
          expressionDistribution: expressionCounts,
          gazeDistribution: gazeCounts,
        };
      }
    }

    // Create a single comprehensive prompt for all questions (including follow-ups)
    const questionsData = allQuestionsForFeedback.map(qd => {
      const visualInfo = visualDataByQuestion[qd.questionNumber];
      return {
        questionNumber: qd.displayNumber,
        question: qd.question,
        expectedAnswer: qd.expectedAnswer,
        userAnswer: qd.userAnswer,
        isFollowUp: qd.isFollowUp || false,
        visualData: visualInfo || null,
      };
    });

    const questionFeedbackPrompt = `You are conducting a technical interview and providing direct feedback to the candidate sitting across from you.

Below are ${allQuestionsForFeedback.length} questions you asked during this interview, along with the candidate's responses.
${followUpQuestions.length > 0 ? `Note: ${followUpQuestions.length} of these are follow-up questions you generated during the interview based on their responses.` : ''}
${Object.keys(visualDataByQuestion).length > 0 ? `\n**IMPORTANT**: During the interview, you observed their body language, facial expressions (${Object.keys(visualDataByQuestion).length} questions have visual data), focus tracking, and gaze direction. Use these observations to assess their confidence, engagement, and communication style.` : ''}

${questionsData.map(qd => `
**Question ${qd.questionNumber}**${qd.isFollowUp ? ' (Follow-up)' : ''}:
Question: ${qd.question}
Expected Answer: ${qd.expectedAnswer}
Candidate's Answer: ${qd.userAnswer}
${qd.visualData ? `
Your Observations (during this answer):
- Focus: ${qd.visualData.focusPercentage}% maintained eye contact
- Expression: Primarily ${qd.visualData.dominantExpression}
- Gaze: ${qd.visualData.dominantGaze}
- Snapshots analyzed: ${qd.visualData.totalSnapshots}` : ''}
`).join('\n---\n')}

Provide direct, personal feedback to the candidate for ALL ${allQuestionsForFeedback.length} questions. Speak as if you're talking directly to them ("you", "your") rather than third person ("the candidate").

Return feedback in the following JSON array format:
[
  {
    "questionNumber": 1,
    "score": <number from 0-10>,
    "areaOfImprovement": "<Direct feedback on what they could improve, 2-3 sentences. Use 'you/your' not 'the candidate'>",
    "whatWentWell": "<Positive aspects of their answer, 2-3 sentences. Use 'you/your' not 'the candidate'>",
    "overallComment": "<Brief overall assessment, 1-2 sentences. Use 'you/your' not 'the candidate'>",
    "visualPerformance": "<1-2 sentences about their visual engagement, confidence, and focus based on your observations. If no visual data, write 'N/A'. Use 'you/your' not 'the candidate'>"
  },
  ... (continue for all ${allQuestionsForFeedback.length} questions)
]

${Object.keys(visualDataByQuestion).length > 0 ? `\nFor questions with visual data, ensure the "visualPerformance" field provides insights about their confidence, engagement, eye contact, and body language based on the metrics provided.` : ''}
Be constructive, specific, and helpful. Make the feedback feel personal and direct. 

IMPORTANT FORMATTING RULES:
- Write in plain text only - NO markdown formatting
- Do NOT use asterisks, underscores, or other markdown symbols (**, *, _, #, etc.)
- Do NOT use bullet points with dashes or asterisks
- Write naturally as if speaking directly to the candidate
- Use simple numbered lists if needed (1., 2., 3.) but no special formatting

Return ONLY the JSON array, no additional text.`;

    let questionFeedbacks = [];
    
    try {
      const data = await callGeminiWithRetry(questionFeedbackPrompt);
      const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      console.log('🤖 Question feedback AI response received');

      // Parse AI response
      try {
        questionFeedbacks = JSON.parse(aiResponse);
      } catch (e) {
        const arrayMatch = aiResponse.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          questionFeedbacks = JSON.parse(arrayMatch[0]);
        } else {
          throw new Error('Failed to parse question feedback');
        }
      }

      // Ensure we have feedback for all questions (including follow-ups)
      if (questionFeedbacks.length !== allQuestionsForFeedback.length) {
        console.warn(`Warning: Expected ${allQuestionsForFeedback.length} feedbacks, got ${questionFeedbacks.length}`);
        // Fill missing feedbacks with default
        while (questionFeedbacks.length < allQuestionsForFeedback.length) {
          questionFeedbacks.push({
            questionNumber: questionFeedbacks.length + 1,
            score: 5,
            areaOfImprovement: 'Unable to generate specific feedback',
            whatWentWell: 'Answer submitted',
            overallComment: 'Please review the expected answer',
          });
        }
      }
    } catch (error) {
      console.error('Error generating question feedback:', error);
      // Create default feedback for all questions (including follow-ups)
      questionFeedbacks = allQuestionsForFeedback.map((_, i) => ({
        questionNumber: i + 1,
        score: 5,
        areaOfImprovement: 'Unable to generate feedback at this time',
        whatWentWell: 'Answer submitted',
        overallComment: 'Please review the expected answer',
      }));
    }

    // Update candidateansbank with question-specific feedback
    // Note: We need to map feedbacks to the ansArray indices properly
    const feedbackDict = new Map();
    const areaOfImprovementArr = [];
    const whatWentWellArr = [];
    const overallCommentsArr = [];
    const visualPerformanceArr = [];

    // Initialize arrays sized to the total number of displayed questions (including follow-ups)
    const maxIndex = allQuestionsForFeedback.length;

    for (let i = 0; i < maxIndex; i++) {
      areaOfImprovementArr[i] = 'N/A';
      whatWentWellArr[i] = 'N/A';
      overallCommentsArr[i] = 'N/A';
      visualPerformanceArr[i] = 'N/A';
    }

    // Map AI-generated feedback (which is in display order) to arrays by display index
    // allQuestionsForFeedback are in the same sorted order as the AI prompt and questionFeedbacks
    allQuestionsForFeedback.forEach((qData, idx) => {
      const feedback = questionFeedbacks[idx];
      if (feedback) {
        const displayIdx = qData.displayNumber - 1; // 0-based
        areaOfImprovementArr[displayIdx] = feedback.areaOfImprovement || 'N/A';
        whatWentWellArr[displayIdx] = feedback.whatWentWell || 'N/A';
        overallCommentsArr[displayIdx] = feedback.overallComment || 'N/A';
        visualPerformanceArr[displayIdx] = feedback.visualPerformance || 'N/A';
      }
    });

    feedbackDict.set('Areaofimprovement', areaOfImprovementArr);
    feedbackDict.set('whatwentwell', whatWentWellArr);
    feedbackDict.set('overallcomments', overallCommentsArr);
    feedbackDict.set('visualPerformance', visualPerformanceArr);
    
    candidateAns.Feedbackdict = feedbackDict;
    await candidateAns.save();

    console.log('✅ Question-specific feedback saved to candidateansbank');

    // Generate overall interview feedback (using 3 parallel API calls)
    console.log('📊 Generating overall interview feedback...');

    // Calculate average score from question feedbacks
    const averageQuestionScore = questionFeedbacks.reduce((sum, f) => sum + (f.score || 5), 0) / allQuestionsForFeedback.length;

    // Get skill, JD, or resume information for better context
    let interviewName = 'Unknown';
    let interviewDescription = '';
    let interviewType = 'Skill';
    
    try {
      // Check if it's a skill-based interview
      if (questionBank.skillid) {
        const skill = await SkillName.findById(questionBank.skillid);
        if (skill) {
          interviewName = skill.name;
          interviewDescription = skill.description || '';
          interviewType = 'Skill';
        }
      } 
      // Check if it's a JD-based interview
      else if (questionBank.jdid) {
        const jd = await JobDescription.findById(questionBank.jdid);
        if (jd) {
          interviewName = jd.title;
          interviewDescription = jd.jdText || '';
          interviewType = 'Job Description';
        }
      }
      // Check if it's a resume-based interview
      else if (questionBank.resumeid) {
        const resume = await Resume.findById(questionBank.resumeid);
        if (resume) {
          interviewName = resume.title;
          interviewDescription = resume.resumeText || '';
          interviewType = 'Resume';
        }
      }
    } catch (err) {
      console.log('Could not fetch interview context info:', err.message);
    }

    // Calculate overall visual analytics summary
    let overallVisualSummary = null;
    if (candidateAns.visualDataArray && candidateAns.visualDataArray.length > 0) {
      const totalSnapshots = candidateAns.visualDataArray.length;
      const focusedSnapshots = candidateAns.visualDataArray.filter(s => s.isFocused).length;
      const overallFocusPercentage = (focusedSnapshots / totalSnapshots) * 100;
      
      // Expression distribution (keep raw counts for storage and percentages for readable prompts)
      const expressionCounts = {};
      for (const s of candidateAns.visualDataArray) {
        const key = s.expression || 'unknown';
        expressionCounts[key] = (expressionCounts[key] || 0) + 1;
      }

      // Gaze distribution (keep raw counts)
      const gazeCounts = {};
      for (const s of candidateAns.visualDataArray) {
        const key = s.gazeDirection || 'unknown';
        gazeCounts[key] = (gazeCounts[key] || 0) + 1;
      }

      // Build readable summaries (percent strings) but keep numeric maps for storage
      const expressionDistributionReadable = Object.entries(expressionCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([expr, count]) => `${expr}: ${((count / totalSnapshots) * 100).toFixed(1)}%`)
        .join(', ');

      const gazeDistributionReadable = Object.entries(gazeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([gaze, count]) => `${gaze}: ${((count / totalSnapshots) * 100).toFixed(1)}%`)
        .join(', ');

      overallVisualSummary = {
        totalSnapshots,
        overallFocusPercentage: Number(overallFocusPercentage.toFixed(1)), // numeric
        expressionDistribution: expressionCounts, // {happy: 12, neutral: 5}
        expressionDistributionReadable,
        gazeDistribution: gazeCounts, // {focused: 10, away: 7}
        gazeDistributionReadable,
        questionsCovered: Object.keys(visualDataByQuestion).length,
      };
      
      console.log('📊 Overall Visual Summary:', overallVisualSummary);
    }

    // Create three separate prompts for parallel API calls to get better quality responses
    
    // Prompt 1: Overview and Growth Improvement (detailed and authentic)
    const overviewPrompt = `You are a senior technical interviewer having a one-on-one feedback session with a candidate who just completed their interview.

**Interview Context**:
- Type: ${interviewType}
- ${interviewType}: ${interviewName}
- ${interviewType} Description: ${interviewDescription.substring(0, 500)}${interviewDescription.length > 500 ? '...' : ''}
- Difficulty Level: ${questionBank.difficultylevel}
- Total Questions Asked: ${allQuestionsForFeedback.length} (${questions.length} base + ${followUpQuestions.length} follow-ups)
- Questions Answered: ${userAnswers.filter(a => a && a.trim()).length}

**Their Performance Across Questions**:
${allQuestionsForFeedback.map((qData, i) => `
Question ${i + 1}${qData.isFollowUp ? ' (Follow-up)' : ''}: ${qData.question}
Their Answer: ${qData.userAnswer}
Expected Points: ${qData.expectedAnswer}
Score: ${questionFeedbacks[i]?.score || 5}/10
What They Did Well: ${questionFeedbacks[i]?.whatWentWell || 'N/A'}
Where They Can Improve: ${questionFeedbacks[i]?.areaOfImprovement || 'N/A'}
`).join('\n---\n')}

${overallVisualSummary ? `
**Your Observations During the Interview**:
You observed their body language and non-verbal cues throughout:
- Maintained focus/eye contact: ${overallVisualSummary.overallFocusPercentage}% of the time
- Facial expressions: ${overallVisualSummary.expressionDistributionReadable}
- Where they looked: ${overallVisualSummary.gazeDistributionReadable}
- Visual data captured for ${overallVisualSummary.questionsCovered} out of ${allQuestionsForFeedback.length} questions
` : ''}

${followUpQuestions.length > 0 ? `\nNote: You asked ${followUpQuestions.length} adaptive follow-up questions during the interview to probe deeper into their understanding.\n` : ''}

Now provide direct, personal feedback to the candidate. Speak to them directly using "you" and "your" (not "the candidate").

Return your feedback in this JSON format:
{
  "overview": "<An array of 3-4 concise bullet points (max 4) analyzing their interview performance. Cover technical depth, problem-solving approach, communication effectiveness, and overall interview presence${overallVisualSummary ? ', including their confidence and engagement based on your observations' : ''}. Each bullet point should be specific, actionable, and reference actual performance patterns. Make this feel like a real interviewer's assessment. Return as an array of strings.>",
  "growthFromLastInterview": "<An array of 3-4 concise, actionable bullet points (max 4) on what they should focus on for their next interview. Be encouraging but honest. Give them concrete areas to work on with specific suggestions. Return as an array of strings, NOT a single string.>"
}

CRITICAL:
- BOTH "overview" and "growthFromLastInterview" MUST be arrays of strings (bullet points)
- Maximum 4 bullet points for each field
- Each bullet point should be concise but substantive (1-2 sentences)
- Don't use generic phrases like "overall performance was satisfactory" - be specific
- Reference specific questions or patterns you noticed in their answers
${overallVisualSummary ? '- Incorporate your observations about their body language and engagement naturally into the feedback' : ''}
- Use "you/your" to make it personal and direct
- Example format: ["First specific point about their performance", "Second point with concrete observation", "Third actionable insight"]

IMPORTANT FORMATTING RULES:
- Write in plain text only - NO markdown formatting
- Do NOT use asterisks, underscores, or other markdown symbols (**, *, _, #, etc.)
- Do NOT use bullet points with dashes or asterisks in the strings
- Write each point as a complete sentence
- Each array element should be a clean string without special formatting

Return ONLY the JSON object, no additional text.`;

    // Prompt 2: Scoring (detailed criteria-based evaluation)
    const scoringPrompt = `You are a technical interviewer evaluating a candidate's interview performance across 5 key dimensions.

**Interview Context**:
- Type: ${interviewType} (${interviewName})
- Difficulty Level: ${questionBank.difficultylevel}
- Total Questions: ${allQuestionsForFeedback.length}
- Average Question Score: ${averageQuestionScore.toFixed(1)}/10

**Complete Question-Answer Analysis**:
${allQuestionsForFeedback.map((qData, i) => `
Question ${i + 1}: ${qData.question}
Expected Answer: ${qData.expectedAnswer}
Candidate's Answer: ${qData.userAnswer}
Question Score: ${questionFeedbacks[i]?.score || 5}/10
${questionFeedbacks[i]?.visualPerformance && questionFeedbacks[i].visualPerformance !== 'N/A' ? `Visual Performance: ${questionFeedbacks[i].visualPerformance}` : ''}
`).join('\n---\n')}

${overallVisualSummary ? `
**Visual Engagement Data Throughout Interview**:
- Overall Focus/Eye Contact: ${overallVisualSummary.overallFocusPercentage}%
- Expression Distribution: ${overallVisualSummary.expressionDistribution}
- Gaze Patterns: ${overallVisualSummary.gazeDistribution}
- Total Observations: ${overallVisualSummary.totalSnapshots} snapshots across ${overallVisualSummary.questionsCovered} questions
` : ''}

Evaluate the candidate across these 5 dimensions. Score from 0-10 where:
- 0-2: Very poor performance, fundamental gaps
- 3-4: Below average, significant improvement needed
- 5-6: Average, meets basic expectations
- 7-8: Good, above average performance
- 9-10: Excellent, outstanding performance

**SCORING CRITERIA**:

1. **Behavioral (0-10)**: Confidence, professionalism, composure, interview presence
   ${overallVisualSummary ? `- HEAVILY weight visual engagement: eye contact (${overallVisualSummary.overallFocusPercentage}%), expressions, body language` : ''}
   - Assess how they carried themselves throughout the interview

2. **Speech Quality (0-10)**: Clarity of expression, articulation, structure of responses
   - How well they communicated their thoughts
   - Organization and coherence of answers

3. **Technical Knowledge (0-10)**: Depth and accuracy of technical understanding
   - Correctness of answers compared to expected responses
   - Demonstration of core concepts and principles

4. **Problem Solving (0-10)**: Analytical thinking, approach to problems, critical reasoning
   - How they broke down problems
   - Quality of their thought process

5. **Communication Skills (0-10)**: Ability to explain concepts clearly and effectively
   ${overallVisualSummary ? `- HEAVILY weight eye contact and focus metrics in this score` : ''}
   - How well they could make complex topics understandable

Return your evaluation in this JSON format:
{
  "behavorial": <score 0-10>,
  "speechQuality": <score 0-10>,
  "technicalKnowledge": <score 0-10>,
  "problemSolving": <score 0-10>,
  "communicationSkills": <score 0-10>,
  "totalScore": <average of all 5 scores above, rounded to 1 decimal>
}

CRITICAL SCORING GUIDELINES:
- Base scores on ACTUAL performance shown in the answers
- For Behavioral and Communication, visual engagement data (focus %, eye contact, expressions) should play a MAJOR role
- Don't inflate scores - if they performed poorly, give low scores (including 0 if truly terrible)
- Don't give average scores just to be nice - be honest and accurate
- If visual data shows poor engagement (low focus %, looking away), reflect this in Behavioral and Communication scores
- Technical Knowledge should be based purely on answer correctness

IMPORTANT FORMATTING RULES:
- Write in plain text only - NO markdown formatting
- Do NOT use asterisks, underscores, or other markdown symbols (**, *, _, #, etc.)

Return ONLY the JSON object, no additional text.`;

    // Prompt 3: Visual Analysis (detailed non-verbal communication assessment)
    const visualAnalysisPrompt = overallVisualSummary ? `You are a communication coach analyzing a candidate's non-verbal communication and presence during a technical interview.

**Interview Context**:
- Interview Type: ${interviewType} - ${interviewName}
- Total Questions: ${allQuestionsForFeedback.length}
- Difficulty Level: ${questionBank.difficultylevel}

**Visual Data Captured Throughout Interview**:
- Total Observations: ${overallVisualSummary.totalSnapshots} snapshots across the interview
- Questions with Visual Data: ${overallVisualSummary.questionsCovered} out of ${allQuestionsForFeedback.length}
- Overall Camera Focus/Eye Contact: ${overallVisualSummary.overallFocusPercentage}%
- Expression Distribution: ${overallVisualSummary.expressionDistribution}
- Gaze Direction Distribution: ${overallVisualSummary.gazeDistribution}

**Question-by-Question Visual Performance**:
${allQuestionsForFeedback.map((qData, i) => {
  const visualInfo = visualDataByQuestion[qData.questionNumber];
  if (!visualInfo) return `Question ${i + 1}: No visual data captured`;
  return `
Question ${i + 1}${qData.isFollowUp ? ' (Follow-up)' : ''}: ${qData.question.substring(0, 80)}...
- Focus on Camera: ${visualInfo.focusPercentage}%
- Dominant Expression: ${visualInfo.dominantExpression}
- Gaze Pattern: ${visualInfo.dominantGaze}
- Expression Breakdown: ${Object.entries(visualInfo.expressionDistribution).map(([expr, count]) => `${expr}(${count})`).join(', ')}
- Gaze Breakdown: ${Object.entries(visualInfo.gazeDistribution).map(([gaze, count]) => `${gaze}(${count})`).join(', ')}`;
}).join('\n---\n')}

Analyze the candidate's visual performance and body language throughout the interview. Provide a comprehensive assessment of their non-verbal communication.

Return your analysis in this JSON format:
{
  "overallEngagement": "<An array of 3-4 concise bullet points (max 4) analyzing their visual engagement, presence, and confidence during the interview. Be specific and reference the data - did they maintain consistent eye contact? Were their expressions appropriate? Did they appear focused or distracted? Each bullet should provide a specific insight. Return as an array of strings.>",
  "areasForImprovement": "<An array of 3-4 concise, actionable bullet points (max 4) on how they can improve their body language, eye contact, facial expressions, and overall presence in future interviews. Be constructive and practical. Reference specific patterns from the data. Return as an array of strings.>"
}

IMPORTANT:
- BOTH fields MUST be arrays of strings (bullet points)
- Maximum 4 bullet points for each field
- Each bullet point should be concise (1-2 sentences)
- Speak directly to the candidate using "you" and "your"
- Make this a proper analysis, not just a conversion of data points into sentences
- Identify patterns and trends in their visual behavior
- Connect their visual performance to interview effectiveness (e.g., good eye contact shows confidence)
- Be specific about what the data reveals about their comfort level, confidence, and engagement
- Provide actionable improvements they can practice
- If the data shows poor engagement, be direct but constructive about it
- Example format: ["Your eye contact was strong at ${overallVisualSummary.overallFocusPercentage}% which demonstrates confidence", "You maintained appropriate expressions throughout most questions"]

IMPORTANT FORMATTING RULES:
- Write in plain text only - NO markdown formatting
- Do NOT use asterisks, underscores, or other markdown symbols (**, *, _, #, etc.)
- Do NOT use bullet points with dashes or asterisks in the strings
- Write each point as a complete sentence
- Each array element should be a clean string without special formatting

Return ONLY the JSON object, no additional text.` : null;

    // Log visual analysis prompt status
    if (visualAnalysisPrompt) {
      console.log('📹 Visual analysis will be included (visual data found)');
    } else {
      console.log('⚠️  No visual analysis prompt (no visual data available)');
    }

    // Make sequential API calls to avoid rate limiting (instead of parallel)
    console.log('📊 Making sequential API calls for: 1) Overview & Growth, 2) Scoring, 3) Visual Analysis');
    
    // Initialize with default values in case API calls fail
    let overviewData = {
      overview: 'Your interview performance is being analyzed. Please check back later for detailed feedback.'
    };
    let scoringData = {
      behavorial: 5,
      speechQuality: 5,
      technicalKnowledge: 5,
      problemSolving: 5,
      communicationSkills: 5,
      totalScore: 5
    };
    let visualAnalysisData = null;
    
    try {
      // Call 1: Overview & Growth (with individual error handling)
      try {
        console.log('📊 Calling API 1/3: Overview & Growth...');
        const overviewResult = await callGeminiWithRetry(overviewPrompt);
        const overviewResponse = overviewResult?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        
        // Use robust JSON extraction (handles control characters and extra text)
        const parsedOverview = extractFirstBalancedJSON(overviewResponse);
        if (parsedOverview) {
          overviewData = parsedOverview;
          console.log('✅ Overview & Growth data parsed successfully');
        } else {
          console.warn('⚠️  Failed to parse overview data, using defaults');
        }
      } catch (overviewError) {
        console.error('⚠️  Overview & Growth API call failed:', overviewError.message);
        console.log('📊 Continuing with default overview data...');
      }
      
      // Delay before next call to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay (increased)
      
      // Call 2: Scoring (with individual error handling)
      try {
        console.log('📊 Calling API 2/3: Scoring...');
        const scoringResult = await callGeminiWithRetry(scoringPrompt);
        const scoringResponse = scoringResult?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        
        // Use robust JSON extraction (handles control characters and extra text)
        const parsedScoring = extractFirstBalancedJSON(scoringResponse);
        if (parsedScoring) {
          scoringData = parsedScoring;
          console.log('✅ Scoring data parsed successfully');
        } else {
          console.warn('⚠️  Failed to parse scoring data, using defaults');
        }
      } catch (scoringError) {
        console.error('⚠️  Scoring API call failed:', scoringError.message);
        console.log('📊 Continuing with default scoring data...');
      }
      
      // Delay before next call to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay (increased)
      console.log('⏰ 3-second delay completed, proceeding to visual analysis check...');
      
      // Parse Visual Analysis response (if present, with individual error handling)
      if (visualAnalysisPrompt) {
        try {
          console.log('📊 Calling API 3/3: Visual Analysis...');
          // Use strict JSON helper which will request reformatting if needed
          const schemaExample = JSON.stringify({
            overallEngagement: ["First bullet point about engagement", "Second bullet point", "Third bullet point"],
            areasForImprovement: ["First improvement suggestion", "Second improvement", "Third improvement"]
          }, null, 2);

          const visualParsed = await callGeminiJSON(visualAnalysisPrompt + '\n\nIMPORTANT: Return only the JSON object exactly matching the schema provided. Both fields MUST be arrays of strings.', schemaExample, 2);

          if (visualParsed) {
            visualAnalysisData = visualParsed;
            // Validate required fields and types (now supports both array and string for backward compatibility)
            // If data is incomplete or invalid, set to null so it won't be saved
            const isEngagementValid = visualAnalysisData.overallEngagement && 
                                      (Array.isArray(visualAnalysisData.overallEngagement) || 
                                       (typeof visualAnalysisData.overallEngagement === 'string' && 
                                        visualAnalysisData.overallEngagement !== 'Visual analysis data incomplete'));
            
            const isImprovementValid = visualAnalysisData.areasForImprovement && 
                                       (Array.isArray(visualAnalysisData.areasForImprovement) || 
                                        (typeof visualAnalysisData.areasForImprovement === 'string' && 
                                         visualAnalysisData.areasForImprovement !== 'Visual analysis data incomplete'));
            
            if (!isEngagementValid || !isImprovementValid) {
              console.warn('⚠️  Visual analysis data incomplete or invalid, skipping visual analysis');
              visualAnalysisData = null;
            } else {
              // Log the types received
              console.log('✅ Visual Analysis data parsed successfully (via callGeminiJSON)');
              console.log('   - overallEngagement type:', Array.isArray(visualAnalysisData.overallEngagement) ? 'array' : typeof visualAnalysisData.overallEngagement);
              console.log('   - areasForImprovement type:', Array.isArray(visualAnalysisData.areasForImprovement) ? 'array' : typeof visualAnalysisData.areasForImprovement);
            }
          } else {
            console.warn('⚠️  Could not extract valid JSON from visual analysis response after retries');
          }
        } catch (visualError) {
          console.error('⚠️  Visual Analysis API call failed:', visualError.message);
          console.log('📊 Continuing without visual analysis data...');
        }
      }
      
      // Combine all the feedback data
      // Keep arrays as arrays for frontend to display as bullet points
      // Only convert to string if it's not already an array (backward compatibility)
      let growthText = overviewData.growthFromLastInterview;
      if (!Array.isArray(growthText) && typeof growthText !== 'string') {
        growthText = String(growthText || 'Continue practicing and focus on consistency.');
        console.log('⚠️  Converted growthFromLastInterview to string (not array or string)');
      }
      // If it's an array, keep it as array for frontend to display as bullet points
      if (Array.isArray(growthText)) {
        console.log('✅ growthFromLastInterview is an array (will display as bullet points)');
      }

      const overallFeedback = {
        overview: overviewData.overview, // Can be array or string
        behavorial: scoringData.behavorial || 0,
        speechQuality: scoringData.speechQuality || 0,
        technicalKnowledge: scoringData.technicalKnowledge || 0,
        problemSolving: scoringData.problemSolving || 0,
        communicationSkills: scoringData.communicationSkills || 0,
        totalScore: scoringData.totalScore || 0,
        growthFromLastInterview: growthText,
      };
      
      // Add visual analysis if present
      if (visualAnalysisData) {
        overallFeedback.visualAnalysis = {
          overallEngagement: visualAnalysisData.overallEngagement || '',
          areasForImprovement: visualAnalysisData.areasForImprovement || '',
        };
      }

      console.log('📊 Overall Feedback Scores:', {
        behavorial: overallFeedback.behavorial,
        speechQuality: overallFeedback.speechQuality,
        technicalKnowledge: overallFeedback.technicalKnowledge,
        problemSolving: overallFeedback.problemSolving,
        communicationSkills: overallFeedback.communicationSkills,
        totalScore: overallFeedback.totalScore,
      });

      // Find the correct interview document (from 'interview' collection) that contains this question bank
      // Support skill-based, JD-based, and resume-based interviews
      const interviewDoc = await interview.findOne({
        $or: [
          { skillid: questionBank.skillid },
          { jdid: questionBank.jdid },
          { resumeid: questionBank.resumeid }
        ],
        difflevel: questionBank.difficultylevel,
        ArrofQuestionbankids: candidateAns.Questionbankid
      });
      
      const interviewId = interviewDoc?._id?.toString() || 'unknown';
      
      if (!interviewDoc) {
        console.warn('⚠️  Could not find interview document for this question bank');
        console.warn('QuestionBank ID:', candidateAns.Questionbankid);
        console.warn('Skill ID:', questionBank.skillid, 'JD ID:', questionBank.jdid, 'Resume ID:', questionBank.resumeid);
      } else {
        console.log(`✅ Found interview document (ID: ${interviewId})`);
      }

      // Create feedback interview record
      const scoreDict = new Map();
      scoreDict.set('Behavorial', overallFeedback.behavorial || 0);
      scoreDict.set('SpeechQuality', overallFeedback.speechQuality || 0);
      scoreDict.set('TechnicalKnowledge', overallFeedback.technicalKnowledge || 0);
      scoreDict.set('ProblemSolving', overallFeedback.problemSolving || 0);
      scoreDict.set('CommunicationSkills', overallFeedback.communicationSkills || 0);

      const feedbackData = {
        username: username,
        candidateAnsBankId: candidateAnsBankId,
        Overview: overallFeedback.overview,
        Scoredict: scoreDict,
        TotalScore: overallFeedback.totalScore || 0,
        interviewId: interviewId,
        Growthfromlastinterview: overallFeedback.growthFromLastInterview,
      };

      // Add visual analysis if present
      if (overallFeedback.visualAnalysis) {
        feedbackData.visualAnalysis = {
          overallEngagement: overallFeedback.visualAnalysis.overallEngagement || '',
          areasForImprovement: overallFeedback.visualAnalysis.areasForImprovement || '',
        };
        console.log('📹 Visual analysis included in feedback');
      }

      // Add visual metrics summary if present
      if (overallVisualSummary) {
        // Prepare safe numeric entries for Map storage
        const rawExpr = overallVisualSummary.expressionDistribution || {};
        const rawGaze = overallVisualSummary.gazeDistribution || {};

        const safeExpressionEntries = Object.entries(rawExpr).map(([k, v]) => [k, Number(v) || 0]);
        const safeGazeEntries = Object.entries(rawGaze).map(([k, v]) => [k, Number(v) || 0]);

        feedbackData.visualMetrics = {
          overallFocusPercentage: Number(overallVisualSummary.overallFocusPercentage) || 0,
          expressionDistribution: new Map(safeExpressionEntries),
          gazeDistribution: new Map(safeGazeEntries),
          totalSnapshots: Number(overallVisualSummary.totalSnapshots) || 0,
          questionsCovered: Number(overallVisualSummary.questionsCovered) || 0,
        };
        console.log('📊 Visual metrics summary included in feedback (numeric maps)');
      }

      const feedbackRecord = await feedbackinterview.create(feedbackData);

      console.log(`✅ Created overall feedback record (ID: ${feedbackRecord._id})`);

      // Update user's interviews document
      const userInterviews = await interviews.findOne({ username });
      if (userInterviews) {
        userInterviews.Arrofinterviewfeedbackids.push(feedbackRecord._id.toString());
        await userInterviews.save();
        console.log('✅ Updated user interviews record with feedback ID');
      } else {
        console.warn('⚠️  User interviews document not found');
      }

      console.log('✅ Overall feedback saved to feedbackinterview');
      
      // CRITICAL: Update metadata status to 'completed' so GET endpoint stops returning 202
      if (metadata) {
        metadata.status = 'completed';
        await metadata.save();
        console.log('✅ Updated interview metadata status to completed');
      }
      
      console.log('✅ Feedback generation completed successfully');
      console.log('='.repeat(80) + '\n');

      res.json({
        success: true,
        message: 'Feedback generated successfully',
        data: {
          candidateAnsBankId: candidateAns._id,
          feedbackId: feedbackRecord._id,
          questionFeedbacks: questionFeedbacks.map(f => ({
            questionNumber: f.questionNumber,
            score: f.score || 5,
            areaOfImprovement: f.areaOfImprovement || 'N/A',
            whatWentWell: f.whatWentWell || 'N/A',
            overallComment: f.overallComment || 'N/A',
          })),
          overallFeedback: {
            overview: overallFeedback.overview,
            scores: {
              behavorial: overallFeedback.behavorial || 5,
              speechQuality: overallFeedback.speechQuality || 5,
              technicalKnowledge: overallFeedback.technicalKnowledge || 5,
              problemSolving: overallFeedback.problemSolving || 5,
              communicationSkills: overallFeedback.communicationSkills || 5,
            },
            totalScore: overallFeedback.totalScore || 5,
            growthFromLastInterview: overallFeedback.growthFromLastInterview,
          },
        },
      });
    } catch (error) {
      console.error('❌ Error generating overall feedback:', error);
      
      // Even if overall feedback fails, we still have question feedback saved
      // Return partial success
      res.status(500).json({
        success: false,
        error: 'Failed to generate complete feedback',
        message: error.message,
        partialData: {
          candidateAnsBankId: candidateAns._id,
          questionFeedbackSaved: true,
        }
      });
      return;
    }
  } catch (error) {
    console.error('❌ Error in feedback generation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate feedback',
      message: error.message,
    });
  }
});

// GET /api/interview/history - Get user's interview history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;

    const userInterviews = await interviews.findOne({ username })
      .populate('Arrofskillids')
      .populate('ArrofInterview');

    if (!userInterviews) {
      return res.json({
        success: true,
        data: {
          skills: [],
          interviews: [],
          totalInterviews: 0,
        },
      });
    }

    // Reverse the candidateAnswers array to show most recent first (LIFO/queue order)
    const reversedCandidateAnswers = [...userInterviews.ArrofCandidatebankids].reverse();

    res.json({
      success: true,
      data: {
        skills: userInterviews.Arrofskillids,
        interviews: userInterviews.ArrofInterview,
        candidateAnswers: reversedCandidateAnswers, // Most recent first
        feedbacks: userInterviews.Arrofinterviewfeedbackids,
        totalInterviews: userInterviews.ArrofInterview.length,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching interview history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch interview history',
      message: error.message,
    });
  }
});

// GET /api/interview/feedback/:candidateAnsBankId - Get feedback for specific interview
router.get('/feedback/:candidateAnsBankId', authenticateToken, async (req, res) => {
  try {
    const { candidateAnsBankId } = req.params;
    const username = req.user.username;

    console.log('\n' + '='.repeat(80));
    console.log('📊 FETCHING FEEDBACK');
    console.log('='.repeat(80));
    console.log('Username:', username);
    console.log('Candidate Answer Bank ID:', candidateAnsBankId);
    console.log('Type of candidateAnsBankId:', typeof candidateAnsBankId);
    console.log('-'.repeat(80));

    // Validate and sanitize candidateAnsBankId
    if (!candidateAnsBankId || typeof candidateAnsBankId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Invalid candidate answer bank ID',
      });
    }

    // Ensure it's a valid MongoDB ObjectId format (24 hex characters)
    const objectIdRegex = /^[0-9a-fA-F]{24}$/;
    if (!objectIdRegex.test(candidateAnsBankId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
      });
    }

    // Find candidate answer bank
    const candidateAns = await candidateansbank.findById(candidateAnsBankId);
    
    if (!candidateAns) {
      return res.status(404).json({
        success: false,
        error: 'Interview not found',
      });
    }

    // Verify ownership
    if (candidateAns.username !== username) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    // Find question bank
    const questionBank = await QuestionBank.findById(candidateAns.Questionbankid);
    
    if (!questionBank) {
      return res.status(404).json({
        success: false,
        error: 'Question bank not found',
      });
    }

    // CRITICAL: Check if feedback is still being generated
    const metadata = await InterviewMetadata.findOne({ candidateAnsBankId: String(candidateAnsBankId) });
    
    if (metadata && metadata.status === 'generating_feedback') {
      console.log('⏳ Feedback is still being generated, returning 202 with partial data');
      
      // Return partial data (interview metadata, questions, answers) without AI feedback
      // Get skill, JD, or resume information
      let skillInfo = null;
      let jdInfo = null;
      let resumeInfo = null;
      let interviewType = 'unknown';
      
      if (questionBank.skillid) {
        skillInfo = await SkillName.findById(questionBank.skillid);
        interviewType = 'skill';
      } else if (questionBank.jdid) {
        jdInfo = await JobDescription.findById(questionBank.jdid);
        interviewType = 'jd';
      } else if (questionBank.resumeid) {
        resumeInfo = await Resume.findById(questionBank.resumeid);
        interviewType = 'resume';
      }

      return res.status(202).json({
        success: false,
        message: 'Feedback generation in progress',
        data: {
          candidateAnsBankId: String(candidateAns._id),
          username: candidateAns.username,
          submittedAt: candidateAns.createdAt,
          interviewType: interviewType,
          skill: skillInfo ? {
            id: String(skillInfo._id),
            name: skillInfo.name,
            description: skillInfo.description,
          } : null,
          jd: jdInfo ? {
            id: String(jdInfo._id),
            title: jdInfo.title,
            jdText: jdInfo.jdText,
          } : null,
          resume: resumeInfo ? {
            id: String(resumeInfo._id),
            title: resumeInfo.title,
            resumeText: resumeInfo.resumeText,
          } : null,
          difficulty: questionBank.difficultylevel,
          totalQuestions: questionBank.questionarr.length,
          baseQuestions: questionBank.questionarr.length,
          followUpQuestions: 0,
          questionsAnswered: candidateAns.ansArray.filter(a => a && a.trim()).length,
          questionFeedbacks: null,
          overallFeedback: null,
        },
      });
    }

    // Find overall feedback directly by candidateAnsBankId (more reliable than array index)
    // Ensure candidateAnsBankId is string when querying
    let overallFeedback = await feedbackinterview.findOne({
      username: username,
      candidateAnsBankId: String(candidateAnsBankId)
    });
    
    if (!overallFeedback) {
      console.log('⚠️  No overall feedback found for this interview');
    } else {
      console.log(`✅ Found overall feedback (ID: ${overallFeedback._id})`);
    }

    // Get skill, JD, or resume information
    let skillInfo = null;
    let jdInfo = null;
    let resumeInfo = null;
    let interviewType = 'unknown';
    
    if (questionBank.skillid) {
      skillInfo = await SkillName.findById(questionBank.skillid);
      interviewType = 'skill';
    } else if (questionBank.jdid) {
      jdInfo = await JobDescription.findById(questionBank.jdid);
      interviewType = 'jd';
    } else if (questionBank.resumeid) {
      resumeInfo = await Resume.findById(questionBank.resumeid);
      interviewType = 'resume';
    }

    // Get interview document (from 'interview' collection)
    let interviewInfo = null;
    try {
      if (interviewType === 'skill') {
        interviewInfo = await interview.findOne({
          skillid: questionBank.skillid,
          difflevel: questionBank.difficultylevel,
          ArrofQuestionbankids: candidateAns.Questionbankid
        });
      } else if (interviewType === 'jd') {
        interviewInfo = await interview.findOne({
          jdid: questionBank.jdid,
          difflevel: questionBank.difficultylevel,
          ArrofQuestionbankids: candidateAns.Questionbankid
        });
      } else if (interviewType === 'resume') {
        interviewInfo = await interview.findOne({
          resumeid: questionBank.resumeid,
          difflevel: questionBank.difficultylevel,
          ArrofQuestionbankids: candidateAns.Questionbankid
        });
      }
    } catch (err) {
      console.log('Could not fetch interview document:', err.message);
    }

    // Prepare question-specific feedback
    const questionFeedbacks = [];
    const feedbackDict = candidateAns.Feedbackdict;
    const areaOfImprovement = feedbackDict.get('Areaofimprovement') || [];
    const whatWentWell = feedbackDict.get('whatwentwell') || [];
    const overallComments = feedbackDict.get('overallcomments') || [];
    const visualPerformance = feedbackDict.get('visualPerformance') || [];

    // PHASE 2: Get follow-up questions for this interview
    const followUpQuestions = await FollowUpQuestion.find({
      candidateAnsBankId: candidateAnsBankId,
    }).sort({ questionNumber: 1 });

    console.log(`📊 Found ${followUpQuestions.length} follow-up questions`);

    // Build a combined list of base questions and follow-ups, ordered correctly
    // Use the integer-based sortKey scheme used during interview runtime:
    //   base questions -> idx * 1000
    //   follow-ups     -> stored integer questionNumber (baseSortKey + n)
    const allQuestions = [];

    // Add base questions (use multiples of 1000 so follow-ups can insert after)
    for (let i = 0; i < questionBank.questionarr.length; i++) {
      const baseSortKey = i * 1000;
      allQuestions.push({
        questionNumber: baseSortKey,
        sortKey: baseSortKey, // Use for sorting
        question: questionBank.questionarr[i],
        expectedAnswer: questionBank.expectedansarr[i],
        userAnswer: candidateAns.ansArray[i] || 'No answer provided',
        isFollowUp: false,
        baseQuestionIndex: i,
        feedback: {
          areaOfImprovement: areaOfImprovement[i] || 'N/A',
          whatWentWell: whatWentWell[i] || 'N/A',
          overallComment: overallComments[i] || 'N/A',
          visualPerformance: visualPerformance[i] || 'N/A',
        },
      });
    }

    // Add follow-up questions
    for (const followUp of followUpQuestions) {
      // originQuestionNumber represents the original display index at generation time
      const originIdx = followUp.originQuestionNumber;
      // Use the stored integer questionNumber as the sort key (consistent with generation)
      const fqSortKey = followUp.questionNumber;
      allQuestions.push({
        questionNumber: fqSortKey,
        sortKey: fqSortKey,
        question: followUp.generatedQuestionText,
        expectedAnswer: followUp.expectedAnswerText,
        userAnswer: followUp.candidateAnswer || 'No answer provided',
        isFollowUp: true,
        originQuestionNumber: originIdx,
        baseQuestionNumber: followUp.baseQuestionNumber,
        detectorConfidence: followUp.detectorConfidence,
        detectorReason: followUp.detectorReason,
        followUpId: followUp._id.toString(),
        feedback: {
          // Map follow-up feedback to its origin base question where appropriate
          areaOfImprovement: areaOfImprovement[originIdx] || 'N/A',
          whatWentWell: whatWentWell[originIdx] || 'N/A',
          overallComment: overallComments[originIdx] || 'N/A',
          visualPerformance: visualPerformance[originIdx] || 'N/A',
        },
      });
    }

    // Sort by sortKey to maintain interview order (base then its follow-ups)
    allQuestions.sort((a, b) => a.sortKey - b.sortKey);

    // Re-map answers and feedback arrays (these are stored by display order)
    const areaOfImprovementArr = feedbackDict.get('Areaofimprovement') || [];
    const whatWentWellArr = feedbackDict.get('whatwentwell') || [];
    const overallCommentsArr = feedbackDict.get('overallcomments') || [];
    const visualPerformanceArr = feedbackDict.get('visualPerformance') || [];

    // Assign display indices and attach user answers + feedback by display index
    for (let i = 0; i < allQuestions.length; i++) {
      const displayIdx = i; // 0-based index in interview flow
      const q = allQuestions[i];
      q.displayIndex = displayIdx;
      q.displayNumber = displayIdx + 1;

      // user answers are stored in candidateAns.ansArray keyed by display order
      q.userAnswer = (candidateAns.ansArray && candidateAns.ansArray[displayIdx]) || 'No answer provided';

      // feedback arrays were stored by display order when generated
      q.feedback = {
        areaOfImprovement: areaOfImprovementArr[displayIdx] || 'N/A',
        whatWentWell: whatWentWellArr[displayIdx] || 'N/A',
        overallComment: overallCommentsArr[displayIdx] || 'N/A',
        visualPerformance: visualPerformanceArr[displayIdx] || 'N/A',
      };
    }

    console.log('✅ Feedback retrieved successfully');
    console.log('='.repeat(80) + '\n');

    res.json({
      success: true,
      data: {
        candidateAnsBankId: String(candidateAns._id), // Ensure string
        username: candidateAns.username,
        submittedAt: candidateAns.createdAt,
        interviewType: interviewType,
        interview: interviewInfo ? {
          id: String(interviewInfo._id), // Ensure string
          skillId: interviewInfo.skillid,
          jdId: interviewInfo.jdid,
          resumeId: interviewInfo.resumeid,
          difficultyLevel: interviewInfo.difflevel,
          count: interviewInfo.count,
        } : null,
        skill: skillInfo ? {
          id: String(skillInfo._id), // Ensure string
          name: skillInfo.name,
          description: skillInfo.description,
        } : null,
        jd: jdInfo ? {
          id: String(jdInfo._id), // Ensure string
          title: jdInfo.title,
          jdText: jdInfo.jdText,
        } : null,
        resume: resumeInfo ? {
          id: String(resumeInfo._id), // Ensure string
          title: resumeInfo.title,
          resumeText: resumeInfo.resumeText,
        } : null,
        difficulty: questionBank.difficultylevel,
        totalQuestions: allQuestions.length, // Updated to include follow-ups
        baseQuestions: questionBank.questionarr.length,
        followUpQuestions: followUpQuestions.length,
        questionsAnswered: candidateAns.ansArray.filter(a => a && a.trim()).length,
        questionFeedbacks: allQuestions, // Now includes both base and follow-up questions
        overallFeedback: overallFeedback ? {
          id: String(overallFeedback._id), // Ensure string
          interviewId: String(overallFeedback.interviewId), // Ensure string
          overview: overallFeedback.Overview,
          scores: {
            behavorial: overallFeedback.Scoredict.get('Behavorial') || 0,
            speechQuality: overallFeedback.Scoredict.get('SpeechQuality') || 0,
            technicalKnowledge: overallFeedback.Scoredict.get('TechnicalKnowledge') || 0,
            problemSolving: overallFeedback.Scoredict.get('ProblemSolving') || 0,
            communicationSkills: overallFeedback.Scoredict.get('CommunicationSkills') || 0,
          },
          totalScore: overallFeedback.TotalScore,
          growthFromLastInterview: overallFeedback.Growthfromlastinterview,
          visualAnalysis: overallFeedback.visualAnalysis || null,
          visualMetrics: overallFeedback.visualMetrics ? {
            overallFocusPercentage: overallFeedback.visualMetrics.overallFocusPercentage || 0,
            // Convert Mongoose Map to plain object if needed
            expressionDistribution: overallFeedback.visualMetrics.expressionDistribution ? (overallFeedback.visualMetrics.expressionDistribution instanceof Map ? Object.fromEntries(overallFeedback.visualMetrics.expressionDistribution) : overallFeedback.visualMetrics.expressionDistribution) : {},
            gazeDistribution: overallFeedback.visualMetrics.gazeDistribution ? (overallFeedback.visualMetrics.gazeDistribution instanceof Map ? Object.fromEntries(overallFeedback.visualMetrics.gazeDistribution) : overallFeedback.visualMetrics.gazeDistribution) : {},
            totalSnapshots: overallFeedback.visualMetrics.totalSnapshots || 0,
            questionsCovered: overallFeedback.visualMetrics.questionsCovered || 0,
          } : null,
        } : null,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching feedback:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch feedback',
      message: error.message,
    });
  }
});

// GET /api/interview/follow-ups/:candidateAnsBankId - Get all follow-up questions for an interview
router.get('/follow-ups/:candidateAnsBankId', authenticateToken, async (req, res) => {
  try {
    const { candidateAnsBankId } = req.params;
    const username = req.user.username;

    // Verify ownership
    const candidateAns = await candidateansbank.findById(candidateAnsBankId);
    if (!candidateAns || candidateAns.username !== username) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    // Get all follow-up questions for this interview
    const followUps = await FollowUpQuestion.find({
      candidateAnsBankId,
    }).sort({ questionNumber: 1 });

    res.json({
      success: true,
      data: followUps.map(fu => ({
        id: fu._id,
        question: fu.generatedQuestionText,
        expectedAnswer: fu.expectedAnswerText,
        questionNumber: fu.questionNumber,
        originQuestionNumber: fu.originQuestionNumber,
        status: fu.status,
        detectorConfidence: fu.detectorConfidence,
        detectorReason: fu.detectorReason,
      })),
    });
  } catch (error) {
    console.error('❌ Error fetching follow-ups:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch follow-up questions',
      message: error.message,
    });
  }
});

// POST /api/interview/heartbeat - lightweight ping to update last_ping
router.post('/heartbeat', authenticateToken, async (req, res) => {
  try {
    const { candidateAnsBankId, questionBankId, last_ping } = req.body;
    const username = req.user.username;

    const filter = { username };
    if (questionBankId) filter.questionBankId = questionBankId;
    if (candidateAnsBankId) filter.candidateAnsBankId = candidateAnsBankId;

    // Use atomic update to avoid version conflicts
    await ExamSession.findOneAndUpdate(
      filter,
      {
        $set: {
          last_ping: last_ping ? new Date(last_ping) : new Date()
        }
      },
      { sort: { createdAt: -1 } }
    );

    res.json({ success: true });
  } catch (e) {
    console.error('heartbeat error', e);
    res.status(500).json({ success: false, error: 'heartbeat failed' });
  }
});

// POST /api/interview/check-followup - Check and generate follow-up question when user stops recording
router.post('/check-followup', authenticateToken, async (req, res) => {
  try {
    const { candidateAnsBankId, questionBankId, questionIndex, answer } = req.body;
    const username = req.user.username;

    if (!questionBankId || typeof questionIndex !== 'number') {
      return res.status(400).json({ success: false, error: 'questionBankId and questionIndex required' });
    }

    console.log(`\n🔍 Check Follow-up: user=${username}, qIdx=${questionIndex}, answerLen=${answer?.length || 0}`);

    let followUpGenerated = null;
    
    // Only try to generate follow-up if we have valid data
    if (candidateAnsBankId && answer && answer.trim().length > 10) {
      try {
        // Get interview metadata
        let metadata = await InterviewMetadata.findOne({ candidateAnsBankId });
        
        if (metadata && metadata.status === 'active') {
          console.log(`   Checking follow-up for question ${questionIndex}...`);
          
          // Get question bank to retrieve question text
          const questionBank = await QuestionBank.findById(questionBankId);
          if (!questionBank) {
            throw new Error('Question bank not found');
          }
          
          // Get candidate answer bank to retrieve all answers and track follow-ups
          const candidateAnsBank = await candidateansbank.findById(candidateAnsBankId);
          if (!candidateAnsBank) {
            throw new Error('Candidate answer bank not found');
          }
          
          // Get all follow-up questions already generated for this interview
          const allFollowUps = await FollowUpQuestion.find({
            candidateAnsBankId,
          }).sort({ questionNumber: 1 });
          
          // Build a complete ordered list of all questions (base + follow-ups)
          // We need to properly track which base question each position corresponds to
          const allQuestions = [];
          
          // Start with base questions - use multiples of 1000 as sorting key to avoid floating point issues
          // Base questions: 0, 1000, 2000, 3000, etc.
          // Follow-ups will insert at: 1, 2, 3 (after 0), 1001, 1002 (after 1000), etc.
          questionBank.questionarr.forEach((q, idx) => {
            allQuestions.push({
              sortKey: idx * 1000, // Use multiples of 1000 for base questions
              text: q,
              isFollowUp: false,
              baseQuestionIndex: idx, // Which base question this is
            });
          });
          
          // Insert follow-up questions - they should appear right after their origin question
          // Use sortKey as: originQuestionNumber + 0.1, 0.2, etc. for proper insertion
          allFollowUps.forEach((followUp, followUpIndex) => {
            allQuestions.push({
              sortKey: followUp.questionNumber, // Use the stored questionNumber as sort key
              text: followUp.generatedQuestionText,
              isFollowUp: true,
              followUpId: followUp._id.toString(),
              originQuestionNumber: followUp.originQuestionNumber,
              baseQuestionNumber: followUp.baseQuestionNumber, // Already stored in DB
            });
          });
          
          // Sort by sortKey to get the correct interview order
          allQuestions.sort((a, b) => a.sortKey - b.sortKey);
          
          // Now assign actual display indices (0, 1, 2, 3...)
          allQuestions.forEach((q, displayIndex) => {
            q.displayIndex = displayIndex;
          });
          
          // Debug: Show the question mapping
          console.log(`   📋 Question Map: ${allQuestions.map((q, i) => 
            q.isFollowUp ? `${i}:F${q.baseQuestionNumber}` : `${i}:B${q.baseQuestionIndex}`
          ).join(', ')}`);
          
          // Find the current question by matching the questionIndex (display position)
          // The questionIndex from frontend represents the actual position (0, 1, 2, 3...)
          const currentQuestionData = allQuestions.find(q => q.displayIndex === questionIndex);
          
          if (!currentQuestionData) {
            console.log(`   ⚠️  Question at index ${questionIndex} not found. Skipping follow-up generation.`);
          } else {
            const currentQuestion = currentQuestionData.text;
            const isFollowUpQuestion = currentQuestionData.isFollowUp;
            
            if (isFollowUpQuestion) {
              console.log(`   📌 Question ${questionIndex} is a follow-up question`);
            }
            
            // Determine the base question number for this question
            let baseQuestionNumber;
            if (isFollowUpQuestion) {
              // This is a follow-up - use the baseQuestionNumber already stored in DB
              baseQuestionNumber = currentQuestionData.baseQuestionNumber;
              
              // If for some reason it's not set, trace back through the parent chain
              if (baseQuestionNumber === undefined) {
                // Find the parent follow-up in the database
                const parentFollowUp = allFollowUps.find(f => f.questionNumber === currentQuestionData.sortKey);
                if (parentFollowUp && parentFollowUp.baseQuestionNumber !== undefined) {
                  baseQuestionNumber = parentFollowUp.baseQuestionNumber;
                } else {
                  // Last resort: use the originQuestionNumber and trace back
                  baseQuestionNumber = currentQuestionData.originQuestionNumber;
                  // Keep tracing back if origin is also a follow-up
                  let traceData = allQuestions.find(q => q.displayIndex === baseQuestionNumber);
                  while (traceData && traceData.isFollowUp) {
                    baseQuestionNumber = traceData.baseQuestionNumber || traceData.originQuestionNumber;
                    traceData = allQuestions.find(q => q.displayIndex === baseQuestionNumber);
                  }
                  // Final fallback: find the actual base question index in the sorted list
                  if (traceData && !traceData.isFollowUp) {
                    baseQuestionNumber = traceData.baseQuestionIndex;
                  }
                }
              }
            } else {
              // This is a base question - use its baseQuestionIndex
              baseQuestionNumber = currentQuestionData.baseQuestionIndex;
            }
            
            console.log(`   🎯 Base question for index ${questionIndex}: ${baseQuestionNumber}`);
            
            // Check how many follow-ups have already been generated for this base question
            const followUpsForBaseQuestion = await FollowUpQuestion.countDocuments({
              candidateAnsBankId,
              baseQuestionNumber: baseQuestionNumber,
            });
            
            const MAX_FOLLOWUPS_PER_BASE = 2;
            
            if (followUpsForBaseQuestion >= MAX_FOLLOWUPS_PER_BASE) {
              console.log(`   ⏭️  Base question ${baseQuestionNumber} already has ${followUpsForBaseQuestion}/${MAX_FOLLOWUPS_PER_BASE} follow-ups. Skipping.`);
              metadata.followupRejectionCount += 1;
            } else {
              console.log(`   ✅ Base question ${baseQuestionNumber} has ${followUpsForBaseQuestion}/${MAX_FOLLOWUPS_PER_BASE} follow-ups. Can generate more.`);
            
              // Check if we've already generated a follow-up for this specific question
              // Use the actual display index to check for duplicates
              const existingFollowUpForThisQuestion = await FollowUpQuestion.findOne({
                candidateAnsBankId,
                originQuestionNumber: questionIndex,
              });
              
              if (existingFollowUpForThisQuestion) {
                console.log(`   ⏭️  Already generated follow-up for question ${questionIndex}. Skipping to prevent loop.`);
                metadata.followupRejectionCount += 1;
              } else {

            // Build previous Q&A pairs for context by iterating the full ordered list (allQuestions)
            const previousQAPairs = [];
            for (const q of allQuestions) {
              if (typeof q.displayIndex !== 'number') continue;
              if (q.displayIndex >= questionIndex) break; // only previous
              const ans = (candidateAnsBank.ansArray && candidateAnsBank.ansArray[q.displayIndex]) || '';
              previousQAPairs.push({
                question: q.text,
                answer: ans,
                isFollowUp: !!q.isFollowUp,
                questionNumber: q.displayIndex,
              });
            }
            
            // Run follow-up detector
            const detectorResult = await detectFollowUpNeed(
              previousQAPairs,
              currentQuestion,
              answer
            );
            
            console.log(`   Detector: need=${detectorResult.need_follow_up}, conf=${detectorResult.confidence.toFixed(2)}, reason="${detectorResult.reason}"`);
            
            // Store the summarized answer for later use in feedback generation
            if (detectorResult.summarized_answer && candidateAnsBankId) {
              try {
                const cand = await candidateansbank.findById(candidateAnsBankId);
                if (cand) {
                  // Initialize summarizedAnsArray if it doesn't exist
                  if (!cand.summarizedAnsArray) {
                    cand.summarizedAnsArray = [];
                  }
                  cand.summarizedAnsArray[questionIndex] = detectorResult.summarized_answer;
                  await cand.save();
                  console.log(`   ✅ Summarized answer saved (tokens reduced)`);
                }
              } catch (saveError) {
                console.error('❌ Error saving summarized answer:', saveError.message);
              }
            }
            
            // Update metadata with detector stats
            metadata.detectorCallCount += 1;
            metadata.avgDetectorConfidence = 
              (metadata.avgDetectorConfidence * (metadata.detectorCallCount - 1) + detectorResult.confidence) / metadata.detectorCallCount;
            
            // Check heuristics to see if we should actually generate the follow-up
            if (detectorResult.need_follow_up) {
              const heuristicCheck = checkFollowUpHeuristics(
                metadata,
                questionIndex,
                detectorResult.confidence
              );
              
              console.log(`   Heuristics: allowed=${heuristicCheck.allowed}, reason="${heuristicCheck.reason}"`);
              
              if (heuristicCheck.allowed) {
                // Generate follow-up question
                console.log(`   ✨ Generating follow-up question...`);
                
                const generatorResult = await generateFollowUpQuestion(
                  previousQAPairs,
                  currentQuestion,
                  answer,
                  detectorResult.reason
                );
                
                console.log(`   Generated: "${generatorResult.follow_up_question}"`);
                
                // Calculate the next question number for dynamic insertion
                // We need to insert this follow-up IMMEDIATELY after the current question
                // Use integer-based sortKey to avoid floating point precision issues
                // Base questions: 0, 1000, 2000, 3000 (multiples of 1000)
                // Follow-ups: parent + 1, parent + 2, parent + 3, etc.
                
                // Find the current question's sortKey
                const currentSortKey = currentQuestionData.sortKey;
                
                // Count how many follow-ups already exist for this specific question
                const followUpsAfterCurrent = await FollowUpQuestion.countDocuments({
                  candidateAnsBankId,
                  originQuestionNumber: questionIndex,
                });
                
                // Use integer increment: currentSortKey + 1, +2, +3, etc.
                // This ensures follow-ups appear right after the question that triggered them
                const newSortKey = currentSortKey + (followUpsAfterCurrent + 1);
                
                console.log(`   📍 Inserting at sortKey ${newSortKey} (after current sortKey ${currentSortKey})`);
                
                // Create and save the follow-up question (handle potential duplicate key due to race)
                let followUpDoc;
                try {
                  followUpDoc = await FollowUpQuestion.create({
                    username,
                    candidateAnsBankId,
                    interviewId: metadata.interviewId,
                    originQuestionId: questionBankId,
                    originQuestionNumber: questionIndex,
                    baseQuestionNumber: baseQuestionNumber, // Track the ultimate base question
                    questionNumber: newSortKey, // Use integer sortKey for proper ordering
                    generatedQuestionText: generatorResult.follow_up_question,
                    expectedAnswerText: generatorResult.expected_answer,
                    detectorConfidence: detectorResult.confidence,
                    detectorReason: detectorResult.reason,
                    status: 'pending',
                    timestampGenerated: new Date(),
                  });
                  console.log(`   ✅ Follow-up saved: ID=${followUpDoc._id}, sortKey=${newSortKey}, base=${baseQuestionNumber}`);
                } catch (createErr) {
                  // Duplicate key - fetch existing doc and continue
                  if (createErr && createErr.code === 11000) {
                    console.warn('   ⚠️ Duplicate follow-up detected (likely race). Loading existing follow-up');
                    followUpDoc = await FollowUpQuestion.findOne({ candidateAnsBankId, originQuestionNumber: questionIndex });
                    if (followUpDoc) {
                      console.log(`   ✅ Existing follow-up loaded: ID=${followUpDoc._id}`);
                    }
                  } else {
                    throw createErr;
                  }
                }
                
                // Update metadata
                metadata.followupCount += 1;
                metadata.currentTotalQuestions += 1;
                metadata.lastFollowupPosition = questionIndex;
                metadata.followupApprovalCount += 1;
                
                // NO COOLDOWN BLOCKING - allow follow-ups on any question
                
                followUpGenerated = {
                  followUpId: followUpDoc._id.toString(),
                  question: generatorResult.follow_up_question,
                  questionNumber: questionIndex + 1, // Frontend expects next display position
                  insertAfter: questionIndex, // 0-based index where to insert (right after current)
                };
              } else {
                // Heuristics rejected
                metadata.followupRejectionCount += 1;
              }
            } else {
              // Detector said no follow-up needed
              metadata.followupRejectionCount += 1;
            }
            } // Close else block for existingFollowUpForThisQuestion check
            } // Close else block for followUpsForBaseQuestion < MAX check
            
            // Update total questions answered
            metadata.totalQuestionsAnswered = Math.max(metadata.totalQuestionsAnswered, questionIndex + 1);
            
            await metadata.save();
          } // Close else block for currentQuestionData check
        }
      } catch (followUpError) {
        // Log error but don't fail the request
        console.error('❌ Error in follow-up generation:', followUpError.message);
        console.error(followUpError.stack);
      }
    }

    // Also save the answer to candidate answer bank
    if (candidateAnsBankId) {
      try {
        const cand = await candidateansbank.findById(candidateAnsBankId);
        if (cand) {
          cand.ansArray[questionIndex] = answer || '';
          await cand.save();
          console.log(`   ✅ Answer saved to candidate answer bank`);
        }
      } catch (saveError) {
        console.error('❌ Error saving answer:', saveError.message);
      }
    }

    res.json({ 
      success: true,
      followUp: followUpGenerated, // Will be null if no follow-up was generated
    });
  } catch (e) {
    console.error('check-followup error', e);
    res.status(500).json({ success: false, error: 'check-followup failed' });
  }
});

// POST /api/interview/violation/start
router.post('/violation/start', authenticateToken, async (req, res) => {
  try {
    const { id, candidateAnsBankId, questionBankId, reason, ts } = req.body;
    const username = req.user.username;

    // Try to update existing session with atomic operation
    const result = await ExamSession.findOneAndUpdate(
      { 
        username, 
        questionBankId,
        'violations.id': id // Check if violation already exists
      },
      {
        $set: {
          'violations.$.ts': ts ? new Date(ts) : new Date(),
          'violations.$.reason': reason,
          last_ping: new Date()
        }
      },
      { 
        sort: { createdAt: -1 },
        new: true 
      }
    );

    // If violation doesn't exist, add it
    if (!result) {
      const session = await ExamSession.findOne({ username, questionBankId }).sort({ createdAt: -1 });
      
      if (!session) {
        // Create new session
        await ExamSession.create({ 
          username, 
          questionBankId, 
          candidateAnsBankId, 
          start_time: new Date(), 
          last_ping: new Date(),
          violations: [{ id, reason, ts: ts ? new Date(ts) : new Date() }]
        });
      } else {
        // Add violation to existing session atomically
        await ExamSession.findOneAndUpdate(
          { username, questionBankId },
          {
            $push: {
              violations: { id, reason, ts: ts ? new Date(ts) : new Date() }
            },
            $set: {
              last_ping: new Date()
            }
          },
          { sort: { createdAt: -1 } }
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('violation start error', e);
    res.status(500).json({ success: false, error: 'violation start failed' });
  }
});

// POST /api/interview/violation/commit
router.post('/violation/commit', authenticateToken, async (req, res) => {
  try {
    const { id, candidateAnsBankId, questionBankId, reason, committed_at } = req.body;
    const username = req.user.username;

    // Use atomic update to avoid version conflicts
    const result = await ExamSession.findOneAndUpdate(
      { 
        username, 
        questionBankId,
        'violations.id': id,
        'violations.committedAt': { $exists: false } // Only update if not already committed
      },
      {
        $set: {
          'violations.$.committedAt': committed_at ? new Date(committed_at) : new Date(),
          status: 'review',
          last_ping: new Date()
        }
      },
      { 
        sort: { createdAt: -1 },
        new: true 
      }
    );

    // If no existing violation found, create it
    if (!result) {
      await ExamSession.findOneAndUpdate(
        { username, questionBankId },
        {
          $push: {
            violations: {
              id,
              reason,
              ts: new Date(),
              committedAt: committed_at ? new Date(committed_at) : new Date()
            }
          },
          $set: {
            status: 'review',
            last_ping: new Date()
          }
        },
        { sort: { createdAt: -1 } }
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error('violation commit error', e);
    res.status(500).json({ success: false, error: 'violation commit failed' });
  }
});

// POST /api/interview/violation/resolved
router.post('/violation/resolved', authenticateToken, async (req, res) => {
  try {
    const { id, candidateAnsBankId, questionBankId, resolved_at, context } = req.body;
    const username = req.user.username;

    // Use atomic update to avoid version conflicts
    const result = await ExamSession.findOneAndUpdate(
      { 
        username, 
        questionBankId,
        'violations.id': id,
        'violations.resolvedAt': { $exists: false } // Only update if not already resolved
      },
      {
        $set: {
          'violations.$.resolvedAt': resolved_at ? new Date(resolved_at) : new Date(),
          last_ping: new Date()
        }
      },
      { 
        sort: { createdAt: -1 },
        new: true 
      }
    );

    res.json({ success: true, updated: !!result });
  } catch (e) {
    console.error('violation resolved error', e);
    res.status(500).json({ success: false, error: 'violation resolved failed' });
  }
});

// POST /api/interview/client-disconnect
// Note: This endpoint doesn't require authentication because it's called via sendBeacon on page unload
// which cannot send custom headers. We identify the session by questionBankId alone.
router.post('/client-disconnect', async (req, res) => {
  try {
    const { candidateAnsBankId, questionBankId, ts, username } = req.body;

    // Try to find session by questionBankId (most recent active one)
    const session = await ExamSession.findOne({ 
      questionBankId, 
      status: { $in: ['active', 'review'] } 
    }).sort({ createdAt: -1 });
    
    if (session) {
      session.status = 'disconnected';
      session.last_ping = ts ? new Date(ts) : new Date();
      await session.save();
    }

    res.json({ success: true });
  } catch (e) {
    console.error('client-disconnect error', e);
    res.status(500).json({ success: false, error: 'client-disconnect failed' });
  }
});

// POST /api/interview/save-visual - Save visual feedback data (called every 3 seconds during interview)
router.post('/save-visual', authenticateToken, async (req, res) => {
  try {
    const { candidateAnsBankId, visualData } = req.body;
    const username = req.user.username;

   
    // Validation
    if (!candidateAnsBankId || !visualData) {
      console.log('❌ Missing candidateAnsBankId or visualData');
      return res.status(400).json({
        success: false,
        error: 'Candidate answer bank ID and visual data are required',
      });
    }

    // Find candidate answer bank
    const candidateAns = await candidateansbank.findById(candidateAnsBankId);
    
    if (!candidateAns) {
      console.log('❌ Candidate answer bank not found');
      return res.status(404).json({
        success: false,
        error: 'Candidate answer bank not found',
      });
    }

    // Verify ownership
    if (candidateAns.username !== username) {
      console.log('❌ Access denied - username mismatch');
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    // Add visual snapshot to array
    const visualSnapshot = {
      timestamp: new Date(visualData.timestamp),
      questionNumber: visualData.questionNumber,
      expression: visualData.expression || 'NEUTRAL',
      expressionConfidence: visualData.expressionConfidence || 0,
      isFocused: visualData.isFocused !== undefined ? visualData.isFocused : true,
      gazeDirection: visualData.gazeDirection || 'CENTER',
      pupilOffsetX: visualData.pupilOffsetX || 0,
      pupilOffsetY: visualData.pupilOffsetY || 0,
    };

    candidateAns.visualDataArray.push(visualSnapshot);
    await candidateAns.save();


    // Silent success - return minimal response
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error saving visual data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save visual data',
    });
  }
});

export default router;
