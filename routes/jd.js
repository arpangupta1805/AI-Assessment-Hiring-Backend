import express from 'express';
import { body, validationResult, param } from 'express-validator';
import { GoogleGenerativeAI } from '@google/generative-ai';
import JobDescription from '../models/JobDescription.js';
import AssessmentSet from '../models/AssessmentSet.js';
import { authenticateToken, requireRecruiter } from '../middleware/auth.js';

const router = express.Router();

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse JD text using Gemini AI
 */
async function parseJDWithAI(jdText) {
  const prompt = `You are an expert HR analyst. Analyze the following job description and extract structured information.

JOB DESCRIPTION:
${jdText}

Return a JSON object with the following structure:
{
  "refinedJD": "A cleaned, well-formatted version of the JD (max 500 words)",
  "aboutCompany": "2-3 sentences about the company",
  "roleTitle": "The job title",
  "roleResponsibilities": ["Array of key responsibilities"],
  "experienceLevel": "One of: fresher, junior, mid, senior, lead, executive",
  "yearsOfExperience": {"min": number, "max": number},
  "technicalSkills": [
    {
      "name": "Skill name",
      "weight": 1-10 (importance),
      "difficulty": "basic/intermediate/advanced",
      "isPrimary": true/false
    }
  ],
  "softSkills": [
    {
      "name": "Skill name",
      "weight": 1-10
    }
  ],
  "toolsAndTechnologies": ["Array of tools/technologies mentioned"],
  "qualifications": ["Array of required qualifications"],
  "evaluationRubrics": "Suggested evaluation criteria for assessing candidates"
}

IMPORTANT:
- Extract at least 5-10 technical skills
- Assign weights based on how frequently/prominently they are mentioned
- Mark skills that are "must have" as isPrimary: true
- Be thorough in extracting responsibilities

Return ONLY valid JSON, no markdown or explanation.`;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Clean the response - remove markdown code blocks if present
    let cleanedResponse = responseText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(cleanedResponse);
    return { success: true, data: parsed };
  } catch (error) {
    console.error('❌ AI parsing error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Calculate default section config based on experience level
 */
function getDefaultSectionConfig(experienceLevel) {
  const configs = {
    fresher: {
      objective: { questionCount: 15, timeMinutes: 20, weight: 35, enabled: true },
      subjective: { questionCount: 3, timeMinutes: 15, weight: 25, enabled: true },
      programming: { questionCount: 1, timeMinutes: 30, weight: 40, enabled: true },
    },
    junior: {
      objective: { questionCount: 12, timeMinutes: 18, weight: 30, enabled: true },
      subjective: { questionCount: 4, timeMinutes: 18, weight: 30, enabled: true },
      programming: { questionCount: 2, timeMinutes: 40, weight: 40, enabled: true },
    },
    mid: {
      objective: { questionCount: 10, timeMinutes: 15, weight: 25, enabled: true },
      subjective: { questionCount: 5, timeMinutes: 20, weight: 35, enabled: true },
      programming: { questionCount: 2, timeMinutes: 45, weight: 40, enabled: true },
    },
    senior: {
      objective: { questionCount: 8, timeMinutes: 12, weight: 20, enabled: true },
      subjective: { questionCount: 6, timeMinutes: 25, weight: 40, enabled: true },
      programming: { questionCount: 2, timeMinutes: 50, weight: 40, enabled: true },
    },
    lead: {
      objective: { questionCount: 5, timeMinutes: 10, weight: 15, enabled: true },
      subjective: { questionCount: 7, timeMinutes: 30, weight: 45, enabled: true },
      programming: { questionCount: 2, timeMinutes: 50, weight: 40, enabled: true },
    },
    executive: {
      objective: { questionCount: 5, timeMinutes: 10, weight: 15, enabled: true },
      subjective: { questionCount: 8, timeMinutes: 35, weight: 55, enabled: true },
      programming: { questionCount: 1, timeMinutes: 30, weight: 30, enabled: true },
    },
  };

  return configs[experienceLevel] || configs.mid;
}

// ============================================================================
// JD CRUD ROUTES
// ============================================================================

/**
 * GET /api/jd
 * Get all JDs for the recruiter's company
 */
router.get('/', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const jds = await JobDescription.find({
      company: req.user.company,
    })
      .sort({ createdAt: -1 })
      .select('-parsedContent.refinedJD -rawText') // Exclude large text fields
      .lean();

    res.json({
      success: true,
      data: jds,
    });
  } catch (error) {
    console.error('❌ Get JDs error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch job descriptions',
    });
  }
});

/**
 * GET /api/jd/:id
 * Get single JD by ID
 */
router.get('/:id', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    }).populate('assessmentSets');

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    res.json({
      success: true,
      data: jd,
    });
  } catch (error) {
    console.error('❌ Get JD error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch job description',
    });
  }
});

/**
 * POST /api/jd/upload
 * Upload/create a new JD (text or file URL)
 */
router.post('/upload', authenticateToken, requireRecruiter, [
  body('jdText').optional().isString(),
  body('fileUrl').optional().isString(),
  body('fileName').optional().isString(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { jdText, fileUrl, fileName } = req.body;

    if (!jdText && !fileUrl) {
      return res.status(400).json({
        success: false,
        error: 'Either jdText or fileUrl is required',
      });
    }

    // Create JD in draft state
    const jd = await JobDescription.create({
      company: req.user.company,
      recruiter: req.user._id,
      rawText: jdText || '',
      rawFileUrl: fileUrl || '',
      rawFileName: fileName || '',
      status: 'draft',
    });

    console.log('✅ JD created:', jd._id);

    res.status(201).json({
      success: true,
      message: 'Job description created',
      data: {
        id: jd._id,
        status: jd.status,
      },
    });
  } catch (error) {
    console.error('❌ Upload JD error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create job description',
    });
  }
});

/**
 * POST /api/jd/:id/parse
 * Parse JD using AI to extract structured data
 */
router.post('/:id/parse', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    });

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    if (!jd.rawText && !jd.rawFileUrl) {
      return res.status(400).json({
        success: false,
        error: 'No JD content to parse',
      });
    }

    // Update status to parsing
    jd.status = 'parsing';
    await jd.save();

    // Get text content (if file URL, you'd need to fetch and extract text)
    const textToParse = jd.rawText;

    if (!textToParse) {
      return res.status(400).json({
        success: false,
        error: 'No text content available for parsing',
      });
    }

    // Parse with AI
    const parseResult = await parseJDWithAI(textToParse);

    if (!parseResult.success) {
      jd.status = 'draft';
      jd.parsingMeta = {
        parsedAt: new Date(),
        parseErrors: [parseResult.error],
        aiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      };
      await jd.save();

      return res.status(500).json({
        success: false,
        error: 'Failed to parse JD',
        details: parseResult.error,
      });
    }

    // Update JD with parsed content
    jd.parsedContent = {
      refinedJD: parseResult.data.refinedJD || '',
      aboutCompany: parseResult.data.aboutCompany || '',
      roleTitle: parseResult.data.roleTitle || '',
      roleResponsibilities: parseResult.data.roleResponsibilities || [],
      experienceLevel: parseResult.data.experienceLevel || 'mid',
      yearsOfExperience: parseResult.data.yearsOfExperience || { min: 0, max: 0 },
      technicalSkills: parseResult.data.technicalSkills || [],
      softSkills: parseResult.data.softSkills || [],
      toolsAndTechnologies: parseResult.data.toolsAndTechnologies || [],
      qualifications: parseResult.data.qualifications || [],
    };

    // Set evaluation rubrics
    jd.evaluationRubrics = parseResult.data.evaluationRubrics || '';

    // Set default section config based on experience level
    jd.assessmentConfig.sections = getDefaultSectionConfig(jd.parsedContent.experienceLevel);
    jd.assessmentConfig.totalTimeMinutes = jd.calculateTotalTime();

    jd.status = 'parsed';
    jd.parsingMeta = {
      parsedAt: new Date(),
      parseErrors: [],
      aiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    };

    await jd.save();

    console.log('✅ JD parsed successfully:', jd._id);

    res.json({
      success: true,
      message: 'JD parsed successfully',
      data: {
        id: jd._id,
        status: jd.status,
        parsedContent: jd.parsedContent,
        evaluationRubrics: jd.evaluationRubrics,
        assessmentConfig: jd.assessmentConfig,
      },
    });
  } catch (error) {
    console.error('❌ Parse JD error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to parse job description',
    });
  }
});

/**
 * PUT /api/jd/:id/config
 * Update assessment configuration
 */
router.put('/:id/config', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    });

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    if (jd.assessmentConfig.isLocked) {
      return res.status(400).json({
        success: false,
        error: 'Assessment is locked and cannot be modified',
      });
    }

    const {
      cutoffScore,
      resumeMatchThreshold,
      sections,
      numberOfSets,
      startTime,
      endTime,
      maxAttempts,
      instructions,
    } = req.body;

    // Update config fields if provided
    if (cutoffScore !== undefined) jd.assessmentConfig.cutoffScore = cutoffScore;
    if (resumeMatchThreshold !== undefined) jd.assessmentConfig.resumeMatchThreshold = resumeMatchThreshold;
    if (sections !== undefined) {
      jd.assessmentConfig.sections = {
        ...jd.assessmentConfig.sections,
        ...sections,
      };
    }
    if (numberOfSets !== undefined) jd.assessmentConfig.numberOfSets = numberOfSets;
    if (startTime !== undefined) jd.assessmentConfig.startTime = startTime;
    if (endTime !== undefined) jd.assessmentConfig.endTime = endTime;
    if (maxAttempts !== undefined) jd.assessmentConfig.maxAttempts = maxAttempts;
    if (instructions !== undefined) jd.assessmentConfig.instructions = instructions;

    // Recalculate total time
    jd.assessmentConfig.totalTimeMinutes = jd.calculateTotalTime();

    await jd.save();

    res.json({
      success: true,
      message: 'Configuration updated',
      data: {
        assessmentConfig: jd.assessmentConfig,
      },
    });
  } catch (error) {
    console.error('❌ Update config error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update configuration',
    });
  }
});

/**
 * PUT /api/jd/:id/skills
 * Update skill weights and priorities
 */
router.put('/:id/skills', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    });

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    if (jd.assessmentConfig.isLocked) {
      return res.status(400).json({
        success: false,
        error: 'Assessment is locked and cannot be modified',
      });
    }

    const { technicalSkills, softSkills } = req.body;

    if (technicalSkills) {
      jd.parsedContent.technicalSkills = technicalSkills;
    }
    if (softSkills) {
      jd.parsedContent.softSkills = softSkills;
    }

    await jd.save();

    res.json({
      success: true,
      message: 'Skills updated',
      data: {
        technicalSkills: jd.parsedContent.technicalSkills,
        softSkills: jd.parsedContent.softSkills,
      },
    });
  } catch (error) {
    console.error('❌ Update skills error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update skills',
    });
  }
});

/**
 * GET /api/jd/:id/rubrics
 * Get evaluation rubrics
 */
router.get('/:id/rubrics', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    }).select('evaluationRubrics parsedContent.roleTitle');

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    res.json({
      success: true,
      data: {
        evaluationRubrics: jd.evaluationRubrics,
        roleTitle: jd.parsedContent?.roleTitle,
      },
    });
  } catch (error) {
    console.error('❌ Get rubrics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get rubrics',
    });
  }
});

/**
 * PUT /api/jd/:id/rubrics
 * Update evaluation rubrics
 */
router.put('/:id/rubrics', authenticateToken, requireRecruiter, [
  body('evaluationRubrics').isString().withMessage('Rubrics must be a string'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    });

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    jd.evaluationRubrics = req.body.evaluationRubrics;
    await jd.save();

    res.json({
      success: true,
      message: 'Rubrics updated',
    });
  } catch (error) {
    console.error('❌ Update rubrics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update rubrics',
    });
  }
});

/**
 * PUT /api/jd/:id/lock
 * Lock or unlock assessment
 */
router.put('/:id/lock', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const { lock } = req.body;

    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    });

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    jd.assessmentConfig.isLocked = lock;
    if (lock) {
      jd.assessmentConfig.lockedAt = new Date();
    } else {
      jd.assessmentConfig.lockedAt = null;
    }

    await jd.save();

    res.json({
      success: true,
      message: lock ? 'Assessment locked' : 'Assessment unlocked',
      data: {
        isLocked: jd.assessmentConfig.isLocked,
        lockedAt: jd.assessmentConfig.lockedAt,
      },
    });
  } catch (error) {
    console.error('❌ Lock/unlock error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to lock/unlock assessment',
    });
  }
});

/**
 * POST /api/jd/:id/generate-link
 * Generate unique assessment link
 * This also triggers question set generation
 */
router.post('/:id/generate-link', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    });

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    if (jd.status !== 'parsed' && jd.status !== 'ready') {
      return res.status(400).json({
        success: false,
        error: 'JD must be parsed before generating link',
      });
    }

    // Validate timing
    const { startTime, endTime } = req.body;

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Start time and end time are required',
      });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);

    if (start >= end) {
      return res.status(400).json({
        success: false,
        error: 'End time must be after start time',
      });
    }

    // Generate unique assessment link
    let assessmentLink = JobDescription.generateAssessmentLink();

    // Ensure uniqueness
    while (await JobDescription.findOne({ 'assessmentConfig.assessmentLink': assessmentLink })) {
      assessmentLink = JobDescription.generateAssessmentLink();
    }

    // Update JD
    jd.assessmentConfig.assessmentLink = assessmentLink;
    jd.assessmentConfig.linkGeneratedAt = new Date();
    jd.assessmentConfig.startTime = start;
    jd.assessmentConfig.endTime = end;
    jd.assessmentConfig.isLocked = true;
    jd.assessmentConfig.lockedAt = new Date();
    jd.status = 'generating_sets';

    await jd.save();

    // Return immediately - set generation will happen in background
    // In production, this would be handled by a queue/worker
    res.json({
      success: true,
      message: 'Assessment link generated. Question sets are being generated.',
      data: {
        assessmentLink,
        fullLink: `${process.env.FRONTEND_URL}/assessment/${assessmentLink}`,
        startTime: jd.assessmentConfig.startTime,
        endTime: jd.assessmentConfig.endTime,
        status: 'generating_sets',
      },
    });

    // Trigger set generation (async, don't await)
    generateQuestionSets(jd._id).catch(err => {
      console.error('❌ Background set generation error:', err);
    });

  } catch (error) {
    console.error('❌ Generate link error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate assessment link',
    });
  }
});

/**
 * DELETE /api/jd/:id
 * Delete a JD
 */
router.delete('/:id', authenticateToken, requireRecruiter, async (req, res) => {
  try {
    const jd = await JobDescription.findOne({
      _id: req.params.id,
      company: req.user.company,
    });

    if (!jd) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found',
      });
    }

    if (jd.status === 'active') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete an active assessment',
      });
    }

    // Delete associated assessment sets
    await AssessmentSet.deleteMany({ jd: jd._id });

    // Delete the JD
    await jd.deleteOne();

    res.json({
      success: true,
      message: 'Job description deleted',
    });
  } catch (error) {
    console.error('❌ Delete JD error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete job description',
    });
  }
});

// ============================================================================
// HELPER: Generate Question Sets (Background Task)
// ============================================================================

async function generateQuestionSets(jdId) {
  try {
    const jd = await JobDescription.findById(jdId);
    if (!jd) {
      console.error('❌ JD not found for set generation:', jdId);
      return;
    }

    const numberOfSets = jd.assessmentConfig.numberOfSets || 3;
    const sections = jd.assessmentConfig.sections;
    const skills = jd.parsedContent.technicalSkills;

    console.log(`🎯 Generating ${numberOfSets} sets for JD:`, jd._id);

    const generatedSets = [];

    for (let setNum = 1; setNum <= numberOfSets; setNum++) {
      console.log(`📝 Generating set ${setNum}/${numberOfSets}...`);

      const set = {
        jd: jd._id,
        setNumber: setNum,
        objectiveQuestions: [],
        subjectiveQuestions: [],
        programmingQuestions: [],
        generationMeta: {
          generatedAt: new Date(),
          aiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        },
      };

      // Generate objective questions
      if (sections.objective.enabled && sections.objective.questionCount > 0) {
        const objectiveResult = await generateObjectiveQuestions(
          jd.parsedContent,
          sections.objective.questionCount,
          jd.evaluationRubrics
        );
        if (objectiveResult.success) {
          set.objectiveQuestions = objectiveResult.questions;
        }
      }

      // Generate subjective questions
      if (sections.subjective.enabled && sections.subjective.questionCount > 0) {
        const subjectiveResult = await generateSubjectiveQuestions(
          jd.parsedContent,
          sections.subjective.questionCount,
          jd.evaluationRubrics
        );
        if (subjectiveResult.success) {
          set.subjectiveQuestions = subjectiveResult.questions;
        }
      }

      // Generate programming questions
      if (sections.programming.enabled && sections.programming.questionCount > 0) {
        const programmingResult = await generateProgrammingQuestions(
          jd.parsedContent,
          sections.programming.questionCount,
          jd.evaluationRubrics
        );
        if (programmingResult.success) {
          set.programmingQuestions = programmingResult.questions;
        }
      }

      // Save the set
      const savedSet = await AssessmentSet.create(set);
      generatedSets.push(savedSet._id);
      console.log(`✅ Set ${setNum} saved:`, savedSet._id);
    }

    // Update JD with generated sets
    jd.assessmentSets = generatedSets;
    jd.status = 'ready';
    await jd.save();

    console.log(`✅ All ${numberOfSets} sets generated for JD:`, jd._id);

  } catch (error) {
    console.error('❌ Error generating question sets:', error);

    // Update JD status to indicate error
    const jd = await JobDescription.findById(jdId);
    if (jd) {
      jd.status = 'parsed'; // Revert to parsed so they can try again
      jd.parsingMeta.parseErrors = [...(jd.parsingMeta.parseErrors || []), error.message];
      await jd.save();
    }
  }
}

async function generateObjectiveQuestions(parsedContent, count, rubrics) {
  const prompt = `Generate ${count} multiple choice questions for a technical assessment.

ROLE: ${parsedContent.roleTitle}
EXPERIENCE LEVEL: ${parsedContent.experienceLevel}
SKILLS TO TEST: ${parsedContent.technicalSkills.map(s => s.name).join(', ')}

Requirements:
- Questions should be relevant to the role
- Mix of easy, medium, and hard questions
- Each question should have 4 options with exactly 1 correct answer
- Cover various skills proportionally to their weights

Return a JSON array of questions:
[
  {
    "questionId": "obj_1",
    "questionText": "Question text here?",
    "options": [
      {"text": "Option A", "isCorrect": false},
      {"text": "Option B", "isCorrect": true},
      {"text": "Option C", "isCorrect": false},
      {"text": "Option D", "isCorrect": false}
    ],
    "skill": "Skill name",
    "difficulty": "easy|medium|hard",
    "points": 1,
    "explanation": "Explanation of correct answer"
  }
]

Return ONLY valid JSON, no markdown.`;

  try {
    const result = await model.generateContent(prompt);
    let response = result.response.text();
    response = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const questions = JSON.parse(response);
    return { success: true, questions };
  } catch (error) {
    console.error('❌ Error generating objective questions:', error);
    return { success: false, error: error.message };
  }
}

async function generateSubjectiveQuestions(parsedContent, count, rubrics) {
  const prompt = `Generate ${count} subjective/open-ended questions for a technical assessment.

ROLE: ${parsedContent.roleTitle}
EXPERIENCE LEVEL: ${parsedContent.experienceLevel}
SKILLS TO TEST: ${parsedContent.technicalSkills.map(s => s.name).join(', ')}
RESPONSIBILITIES: ${parsedContent.roleResponsibilities.slice(0, 5).join(', ')}

Requirements:
- Questions should test understanding, analysis, and problem-solving
- Mix scenario-based and conceptual questions
- Appropriate for the experience level

Return a JSON array:
[
  {
    "questionId": "sub_1",
    "questionText": "Detailed question here?",
    "expectedAnswer": "Key points the answer should cover",
    "rubric": "Grading criteria: what to look for",
    "skill": "Skill name",
    "difficulty": "easy|medium|hard",
    "points": 10,
    "maxWords": 500
  }
]

Return ONLY valid JSON, no markdown.`;

  try {
    const result = await model.generateContent(prompt);
    let response = result.response.text();
    response = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const questions = JSON.parse(response);
    return { success: true, questions };
  } catch (error) {
    console.error('❌ Error generating subjective questions:', error);
    return { success: false, error: error.message };
  }
}

async function generateProgrammingQuestions(parsedContent, count, rubrics) {
  const prompt = `Generate ${count} programming/coding questions for a technical assessment.

ROLE: ${parsedContent.roleTitle}
EXPERIENCE LEVEL: ${parsedContent.experienceLevel}
TECHNOLOGIES: ${parsedContent.toolsAndTechnologies.join(', ')}

Requirements:
- Practical, real-world scenarios
- Clear problem statements
- Include 2-3 sample test cases and 2-3 hidden test cases
- Appropriate complexity for the experience level

Return a JSON array:
[
  {
    "questionId": "prog_1",
    "title": "Problem Title",
    "questionText": "Complete problem description",
    "description": "Additional context and requirements",
    "constraints": "Input/output constraints",
    "sampleInput": "Example input",
    "sampleOutput": "Example output",
    "testCases": [
      {"input": "test input 1", "expectedOutput": "expected output 1", "isHidden": false, "isSample": true, "weight": 1},
      {"input": "test input 2", "expectedOutput": "expected output 2", "isHidden": false, "isSample": true, "weight": 1},
      {"input": "hidden test 1", "expectedOutput": "hidden output 1", "isHidden": true, "isSample": false, "weight": 2},
      {"input": "hidden test 2", "expectedOutput": "hidden output 2", "isHidden": true, "isSample": false, "weight": 2}
    ],
    "skill": "Primary skill tested",
    "difficulty": "easy|medium|hard",
    "points": 20,
    "allowedLanguages": ["python", "javascript", "java", "cpp"],
    "timeLimit": 2,
    "memoryLimit": 256
  }
]

Return ONLY valid JSON, no markdown.`;

  try {
    const result = await model.generateContent(prompt);
    let response = result.response.text();
    response = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const questions = JSON.parse(response);
    return { success: true, questions };
  } catch (error) {
    console.error('❌ Error generating programming questions:', error);
    return { success: false, error: error.message };
  }
}

export default router;
