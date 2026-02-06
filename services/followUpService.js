// Follow-up Question Detection and Generation Services
// Phase 2: Adaptive, context-aware follow-up questions

// Helper function to call Gemini API with retry logic
const callGeminiWithRetry = async (prompt, maxRetries = 3, temperature = 0.7, modelName = null) => {
  const model = modelName || process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: temperature,
            maxOutputTokens: 1024,
          },
        }),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : Math.pow(2, attempt) * 5000; // Exponential backoff: 5s, 10s, 20s (more conservative for rate limits)
        
        console.log(`⚠️  Rate limited. Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
        
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          throw new Error('Gemini API rate limit exceeded');
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      if (attempt === maxRetries - 1 || error.message.includes('rate limit')) {
        throw error;
      }
      
      const delay = Math.pow(2, attempt) * 5000; // 5s, 10s, 20s (more conservative)
      console.log(`⚠️  Gemini API error: ${error.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Helper: extract first balanced JSON object from text by tracking brace depth
export const extractFirstBalancedJSON = (text) => {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0) {
      const candidate = text.slice(start, i + 1);
      try {
        return JSON.parse(candidate);
      } catch (e) {
        return null;
      }
    }
  }
  return null;
};

// Helper: sanitize and truncate strings
const sanitizeString = (s, maxLen = 1000) => {
  if (!s && s !== '') return '';
  let out = String(s).trim();
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
};

// Helper: check simple duplicate against recent questions (exact normalized match)
const isDuplicateQuestion = (candidate, previousQAPairs) => {
  if (!candidate) return false;
  const norm = candidate.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const p of previousQAPairs.slice(-6)) { // check last up to 6
    const q = (p.question || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!q) continue;
    if (q === norm) return true;
  }
  return false;
};

/**
 * Follow-up Question Detector
 * Uses a small, fast LLM to detect if a follow-up question is needed
 * 
 * @param {Array} previousQAPairs - Array of {question, answer} objects
 * @param {String} currentQuestion - The current question text
 * @param {String} currentAnswer - The candidate's answer to current question
 * @returns {Object} - { need_follow_up: boolean, confidence: number, reason: string }
 */
export const detectFollowUpNeed = async (previousQAPairs, currentQuestion, currentAnswer) => {
  const startTime = Date.now();
  
  try {
    // Build context from previous Q&A pairs
    const contextText = previousQAPairs.length > 0
      ? previousQAPairs.map((qa, idx) => 
          `Q${idx + 1}: ${qa.question}\nA${idx + 1}: ${qa.answer}`
        ).join('\n\n')
      : 'No previous questions in this interview.';

    const prompt = `You are an expert interviewer analyzer. Your task is to determine if a follow-up question is needed based on a candidate's answer.

**Context - Previous Questions & Answers**:
${contextText}

**Current Question**:
${currentQuestion}

**Candidate's Answer**:
${currentAnswer}

**Your Task**:
Analyze the candidate's answer to the current question. You need to do TWO things:

1. **Determine if a follow-up question is needed** based on:
   - Probe deeper into a superficial or vague answer
   - Explore an interesting point that needs elaboration
   - Test understanding when the answer seems memorized or theoretical
   - Clarify contradictions or gaps in reasoning
   - Ask for practical examples or real-world application

2. **Summarize the candidate's answer** in a concise way (MAXIMUM 200 tokens, less is better - aim for as less tokens as possible while retaining key info). This summary will be used later for feedback generation, so it should capture the essence of the answer without unnecessary detail.

**Summary Guidelines**:
   - Extract key points, technical concepts, and main ideas
   - Remove filler words and redundancy
   - Keep important details and examples
   - Maintain the core meaning and substance

**Important Guidelines for Follow-up Detection**:
- BE REASONABLY SELECTIVE: Recommend follow-up when there's clear value in deeper exploration
- RECOMMEND follow-up when:
  * Answer is superficial without examples or depth
  * Answer is vague or lacks specifics
  * Answer suggests memorization without understanding
  * Answer opens an interesting technical point worth exploring
  * Answer has gaps or contradictions
  * Answer could benefit from practical examples or real-world scenarios
  * Candidate mentions concepts that warrant deeper investigation
- DO NOT recommend follow-up for:
  * Complete, well-explained answers with good examples
  * Questions already thoroughly answered
  * When answer is appropriate and comprehensive for the question's scope
  * When follow-up would be repetitive or not add significant value

**Response Format** (JSON only):
{
  "need_follow_up": true or false,
  "confidence": <number between 0.0 and 1.0>,
  "reason": "<one concise sentence explaining your decision>",
  "summarized_answer": "<concise summary of the answer in 100-200 tokens maximum>"
}

Return ONLY the JSON object, no additional text or markdown.`;

    // Use low temperature for more deterministic, conservative decisions
    const data = await callGeminiWithRetry(prompt, 3, 0.3, process.env.SMALLER_MODEL); // Fast, small model
    
    const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Try robust extraction of first balanced JSON
    let result = extractFirstBalancedJSON(aiResponse);
    if (!result) {
      // Fallback to regex fallback (existing) but still sanitize
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { result = JSON.parse(jsonMatch[0]); } catch (e) { result = null; }
      }
    }

    if (!result) {
      console.error('Failed to parse detector response (raw):', aiResponse);
      throw new Error('Failed to parse detector response');
    }

    // Ensure confidence is a number between 0 and 1
    result.confidence = Math.max(0, Math.min(1, parseFloat(result.confidence) || 0));
    
    // Ensure summarized_answer exists, fallback to original answer if not provided
    const summarizedAnswer = result.summarized_answer || result.summarizedAnswer || currentAnswer;
    
    const latency = Date.now() - startTime;
    console.log(`🔍 Detector: need_follow_up=${result.need_follow_up}, confidence=${result.confidence.toFixed(2)}, latency=${latency}ms`);
    
    return {
      need_follow_up: Boolean(result.need_follow_up),
      confidence: result.confidence,
      reason: result.reason || 'No reason provided',
      summarized_answer: summarizedAnswer,
      latency,
    };
  } catch (error) {
    console.error('❌ Error in follow-up detector:', error);
    
    // Return conservative default on error (use original answer as fallback)
    return {
      need_follow_up: false,
      confidence: 0,
      reason: 'Error in detection: ' + error.message,
      summarized_answer: currentAnswer, // Fallback to original answer
      latency: Date.now() - startTime,
    };
  }
};

/**
 * Follow-up Question Generator
 * Uses Gemini 2.0 Flash to generate a contextual follow-up question
 * 
 * @param {Array} previousQAPairs - Array of {question, answer} objects  
 * @param {String} currentQuestion - The current question text
 * @param {String} currentAnswer - The candidate's answer to current question
 * @param {String} detectorReason - The reason from the detector
 * @returns {Object} - { follow_up_question: string, expected_answer: string }
 */
export const generateFollowUpQuestion = async (previousQAPairs, currentQuestion, currentAnswer, detectorReason) => {
  const startTime = Date.now();
  
  try {
    // Build context from previous Q&A pairs (for avoiding repetition)
    const contextText = previousQAPairs.length > 0
      ? previousQAPairs.map((qa, idx) => 
          `Q${idx + 1}: ${qa.question}\nA${idx + 1}: ${qa.answer}`
        ).join('\n\n')
      : 'No previous questions in this interview.';

    const prompt = `You are an expert technical interviewer. Generate a single, focused follow-up question based on the candidate's recent answer.

**Previous Interview Context** (for avoiding repetition):
${contextText}

**Current Question That Was Just Answered**:
${currentQuestion}

**Candidate's Answer**:
${currentAnswer}

**Reason for Follow-up**:
${detectorReason}

**Your Task**:
Create ONE concise, probing follow-up question that:
1. Directly relates to the current question and answer (NOT previous questions)
2. Addresses the specific gap or issue identified in the reason
3. Encourages the candidate to provide examples, elaborate, or clarify
4. Is focused and specific (not too broad)
5. Can be answered in 2-3 minutes
6. Does NOT repeat topics already covered in previous questions

**Important**:
- Focus ONLY on the current question/answer pair
- Use previous context ONLY to avoid repetition
- Keep the follow-up short and focused (one sentence if possible)
- Make it conversational and natural
- Include what a good answer should contain

**Response Format** (JSON only):
{
  "follow_up_question": "<your concise follow-up question>",
  "expected_answer": "<a brief 3-4 line description of what a good answer should include>"
}

Return ONLY the JSON object, no additional text or markdown.`;

    const data = await callGeminiWithRetry(prompt, 3, 0.7, 'gemini-2.0-flash'); // Large, capable model
    
    const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Robust parse
    let result = extractFirstBalancedJSON(aiResponse);
    if (!result) {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { result = JSON.parse(jsonMatch[0]); } catch (e) { result = null; }
      }
    }

    if (!result) {
      console.error('Failed to parse generator response (raw):', aiResponse);
      throw new Error('Failed to parse generator response');
    }

    // Normalize fields
    let followUpQuestion = sanitizeString(result.follow_up_question || result.followUpQuestion || 'Can you elaborate on that?', 500);
    let expectedAnswer = sanitizeString(result.expected_answer || result.expectedAnswer || 'A detailed answer with examples.', 2000);

    // If generated question duplicates recent ones, attempt one regeneration with a slight prompt tweak
    if (isDuplicateQuestion(followUpQuestion, previousQAPairs)) {
      console.log('   ⚠️ Generator produced duplicate question; retrying once with stricter prompt');
      const retryPrompt = prompt + '\n\nPlease ensure the follow-up question is NOT a repeat of previous questions and is more specific.';
      const retryData = await callGeminiWithRetry(retryPrompt, 1, 0.7, 'gemini-2.0-flash');
  const retryText = retryData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      let retryResult = extractFirstBalancedJSON(retryText);
      if (!retryResult) {
        const jsonMatch = retryText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { retryResult = JSON.parse(jsonMatch[0]); } catch (e) { retryResult = null; }
        }
      }
      if (retryResult) {
        followUpQuestion = sanitizeString(retryResult.follow_up_question || retryResult.followUpQuestion || followUpQuestion, 500);
        expectedAnswer = sanitizeString(retryResult.expected_answer || retryResult.expectedAnswer || expectedAnswer, 2000);
      }
    }

    const latency = Date.now() - startTime;
    console.log(`✨ Generator: Generated follow-up question, latency=${latency}ms`);

    return {
      follow_up_question: followUpQuestion,
      expected_answer: expectedAnswer,
      latency,
    };
  } catch (error) {
    console.error('❌ Error in follow-up generator:', error);
    throw error;
  }
};

/**
 * Check if follow-up should be generated based on heuristics
 * 
 * @param {Object} metadata - InterviewMetadata document
 * @param {Number} currentQuestionNumber - The question number that was just answered
 * @param {Number} detectorConfidence - Confidence from detector (0-1)
 * @returns {Object} - { allowed: boolean, reason: string }
 */
export const checkFollowUpHeuristics = (metadata, currentQuestionNumber, detectorConfidence) => {
  // BALANCED DISTRIBUTION STRATEGY
  // Goal: ~1.5x follow-ups per base question, distributed throughout interview
  // Example: 3 base questions, max 10 total → target 6-7 follow-ups (1.5 * 3 = 4.5, rounded up)
  
  const baseQuestionsCount = metadata.baseQuestionCount; // Original number of base questions (FIXED: was questionCount)
  const targetTotalQuestions = metadata.maxQuestions; // Max questions allowed
  const currentTotal = metadata.currentTotalQuestions; // Current total (base + follow-ups generated)
  const followupsGenerated = metadata.followupCount; // Follow-ups generated so far
  
  // Calculate target follow-ups: 1.5x base questions, but capped by maxQuestions
  const targetFollowups = Math.min(
    Math.ceil(baseQuestionsCount * 1.5),
    targetTotalQuestions - baseQuestionsCount
  );
  
  // How many base questions are left to ask (after current one)
  const baseQuestionsRemaining = baseQuestionsCount - currentQuestionNumber - 1;
  
  // Calculate ideal follow-ups remaining to reach target
  const idealFollowupsRemaining = targetFollowups - followupsGenerated;
  
  // Calculate available slots (max total - current total - base questions remaining)
  const availableSlots = Math.max(0, targetTotalQuestions - currentTotal - Math.max(0, baseQuestionsRemaining));
  
  console.log(`   📊 Follow-up Budget: generated=${followupsGenerated}/${targetFollowups} target, baseRemaining=${baseQuestionsRemaining}, availableSlots=${availableSlots}`);
  
  // Check 1: STRICT confidence threshold - ALWAYS require 0.65+
  const CONFIDENCE_THRESHOLD = 0.65;
  if (detectorConfidence < CONFIDENCE_THRESHOLD) {
    return {
      allowed: false,
      reason: `Confidence ${detectorConfidence.toFixed(2)} below threshold ${CONFIDENCE_THRESHOLD}`,
    };
  }
  
  // Check 2: Max questions limit - MUST NOT EXCEED
  if (currentTotal >= targetTotalQuestions) {
    return {
      allowed: false,
      reason: `Max questions limit reached (${targetTotalQuestions})`,
    };
  }
  
  // Check 3: Don't generate if we'd run out of slots for remaining base questions
  if (availableSlots < 1) {
    return {
      allowed: false,
      reason: `No available slots: need space for ${baseQuestionsRemaining} base questions`,
    };
  }
  
  // Check 4: Smart distribution - check if we should generate based on remaining budget
  // Allow if we're below target OR if we have room and good answers warrant follow-ups
  if (followupsGenerated >= targetFollowups) {
    // Already at or above target - only allow if we have lots of room
    if (availableSlots <= 2) {
      return {
        allowed: false,
        reason: `Target follow-ups reached (${followupsGenerated}/${targetFollowups}), limited slots remaining`,
      };
    }
    // Have room and high confidence - allow occasional extra follow-up
    if (detectorConfidence < 0.75) {
      return {
        allowed: false,
        reason: `At target, require higher confidence (0.75+) for extra follow-ups`,
      };
    }
  }

  // NO COOLDOWN/BLOCKING CHECKS - allow follow-ups on any question
  
  // Calculate how on-pace we are
  const paceRatio = (currentQuestionNumber + 1) > 0 ? followupsGenerated / (currentQuestionNumber + 1) : 0;
  const targetPaceRatio = baseQuestionsCount > 0 ? targetFollowups / baseQuestionsCount : 0;
  
  let reason = 'All heuristics passed';
  if (followupsGenerated < targetFollowups) {
    const behind = paceRatio < targetPaceRatio * 0.8;
    reason = behind 
      ? `Behind pace: generating to reach ${targetFollowups} target (${followupsGenerated} so far)`
      : `On pace: ${followupsGenerated}/${targetFollowups} target`;
  }

  return {
    allowed: true,
    reason,
  };
};
