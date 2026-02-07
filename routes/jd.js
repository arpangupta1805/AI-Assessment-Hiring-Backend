import express from 'express';
import { body, validationResult, param } from 'express-validator';
import { callOpenAI } from '../lib/openai.js';
import JobDescription from '../models/JobDescription.js';
import AssessmentSet from '../models/AssessmentSet.js';
import { authenticateToken, requireRecruiter } from '../middleware/auth.js';

const router = express.Router();

// OpenAI client initialized in lib/openai.js


// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse JD text using OpenAI
 */
async function parseJDWithAI(jdText) {
  const prompt = `You are an expert HR analyst. Analyze the following job description and extract structured information.

JOB DESCRIPTION:
${jdText}

Return a JSON object with the following structure:
{
  "refinedJD": "A cleaned, well-formatted version of the JD (max 500 words). Maintain professional tone.",
  "companyName": "Exact name of the hiring company (or 'Confidential' if not mentioned)",
  "aboutCompany": "2-3 sentences about the company, culture, and mission.",
  "roleTitle": "The specific job title (e.g., 'Senior Frontend Engineer')",
  "roleResponsibilities": [
    "3-5 short, actionable responsibilities (e.g., 'Build responsive UI components', 'Optimize API performance')"
  ],
  "experienceLevel": "One of: fresher, junior, mid, senior, lead, executive",
  "yearsOfExperience": {"min": number, "max": number},
  "technicalSkills": [
    {
      "name": "Skill name (e.g., React, Node.js)",
      "category": "One of: Frontend, Backend, Database, DevOps, Mobile, Tools, Core, Other",
      "weight": 1-10 (importance for the role),
      "difficulty": "basic/intermediate/advanced",
      "isPrimary": true/false (true = Must Have/Core, false = Good to Have/Optional)
    }
  ],
  "softSkills": [
    {
      "name": "Skill name (e.g., Problem Solving, Communication)",
      "weight": 1-10 (focus on logical reasoning and adaptability)
    }
  ],
  "toolsAndTechnologies": ["Array of specific tools mentioned (e.g., Jira, AWS, Docker)"],
  "qualifications": ["Array of required degrees or certifications"],
  "suggestedDifficulty": "basic/intermediate/advanced",
  "evaluationRubrics": "Markdown formatted evaluation criteria for assessing candidates."
}

IMPORTANT GUIDELINES:
1. **Skill Categorization**: Group skills logically (e.g., HTML/CSS -> Frontend, Python/Node -> Backend).
2. **Tech Stack Breadth**: For 'fresher' or 'junior' roles, DO NOT mark too many advanced skills as 'isPrimary'. Focus on Core skills.
   - Example: For a Junior Dev, HTML/CSS/JS are Primary. Docker/Kubernetes are likely optional.
3. **Responsibilities**: Extract clear, actionable tasks, not just generic statements.
4. **Soft Skills**: Focus on evaluable traits like 'Analytical Thinking', 'Debug Strategy', rather than generic 'Hard working'.
5. **Accuracy**: Ensure extracted years of experience matches the text exactly.

Return ONLY valid JSON, no markdown.`;

  try {
    const parsed = await callOpenAI(prompt, process.env.OPENAI_MODEL || 'gpt-4o', true);
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
    }).populate('assessmentSets').populate('company');

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

    // Idempotency check: If already parsed, return existing result
    if (jd.status === 'parsed' && jd.parsedContent && jd.parsedContent.experienceLevel) {
      console.log('✅ JD already parsed, returning existing result:', jd._id);
      return res.json({
        success: true,
        message: 'JD already parsed',
        data: {
          id: jd._id,
          status: jd.status,
          parsedContent: jd.parsedContent,
          evaluationRubrics: jd.evaluationRubrics,
          assessmentConfig: jd.assessmentConfig,
        },
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
        aiModel: process.env.OPENAI_MODEL || 'gpt-4o',
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
      companyName: parseResult.data.companyName || '',
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
      aiModel: process.env.OPENAI_MODEL || 'gpt-4o',
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

    const {
      cutoffScore,
      resumeMatchThreshold,
      sections,
      numberOfSets,
      startTime,
      endTime,
      maxAttempts,
      instructions,
      difficultyDistribution,
    } = req.body;

    // Check if test has already started (Lock logic)
    const now = new Date();
    const testStarted = jd.assessmentConfig.startTime && now >= new Date(jd.assessmentConfig.startTime);

    // If test started, only allow updating endTime
    if (testStarted) {
      if (cutoffScore !== undefined || resumeMatchThreshold !== undefined || sections !== undefined ||
        numberOfSets !== undefined || startTime !== undefined || maxAttempts !== undefined ||
        instructions !== undefined || difficultyDistribution !== undefined) {
        return res.status(400).json({
          success: false,
          error: 'Assessment has already started. Only End Time can be modified now.',
        });
      }
    }

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
    if (difficultyDistribution !== undefined) {
      jd.assessmentConfig.difficultyDistribution = {
        ...jd.assessmentConfig.difficultyDistribution,
        ...difficultyDistribution,
      };
    }

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

    // Check if test has already started
    const now = new Date();
    if (jd.assessmentConfig.startTime && now >= new Date(jd.assessmentConfig.startTime)) {
      return res.status(400).json({
        success: false,
        error: 'Assessment has already started and skills cannot be modified',
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

    // Check if test has already started
    const now = new Date();
    if (jd.assessmentConfig.startTime && now >= new Date(jd.assessmentConfig.startTime)) {
      return res.status(400).json({
        success: false,
        error: 'Assessment has already started and rubrics cannot be modified',
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
 * POST /api/jd/:id/generate-questions
 * Generate question sets without creating a link yet
 */
router.post('/:id/generate-questions', authenticateToken, requireRecruiter, async (req, res) => {
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

    // Update config if provided
    if (req.body.numberOfSets) {
      await JobDescription.findByIdAndUpdate(req.params.id, {
        $set: { 'assessmentConfig.numberOfSets': req.body.numberOfSets }
      });
    }

    // Trigger set generation and wait
    const result = await generateQuestionSets(req.params.id);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to generate question sets',
        details: result.error
      });
    }

    res.json({
      success: true,
      message: 'Question sets generated successfully',
      data: { sets: result.sets }
    });
  } catch (error) {
    console.error('❌ Generate questions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start question generation',
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
    const updateData = {
      'assessmentConfig.assessmentLink': assessmentLink,
      'assessmentConfig.linkGeneratedAt': new Date(),
      'assessmentConfig.startTime': start,
      'assessmentConfig.endTime': end,
      // Removed automatic isLocked = true to allow edits until startTime
      status: 'generating_sets'
    };

    await JobDescription.findByIdAndUpdate(jd._id, { $set: updateData });

    // Trigger set generation and MAINTAIN sequence (Wait for success)
    console.log(`⏳ Starting question generation for JD ${jd._id} before returning link...`);
    const generationResult = await generateQuestionSets(jd._id);

    if (!generationResult.success) {
      return res.status(500).json({
        success: false,
        error: 'Assessment link generated, but question set generation failed.',
        details: generationResult.error
      });
    }

    res.json({
      success: true,
      message: 'Assessment link generated and question sets are ready.',
      data: {
        assessmentLink,
        fullLink: `${process.env.FRONTEND_URL}/assessment/${assessmentLink}`,
        startTime: start,
        endTime: end,
        status: 'ready',
      },
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
      return { success: false, error: 'JD not found' };
    }

    const numberOfSets = jd.assessmentConfig.numberOfSets || 3;
    const sections = jd.assessmentConfig.sections;

    console.log(`🎯 Generating ${numberOfSets} sets for JD: ${jd._id}`);

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
          aiModel: process.env.OPENAI_MODEL || 'gpt-4o',
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
      console.log(`✅ Set ${setNum} saved: ${savedSet._id}`);
    }

    // Update JD with generated sets using findByIdAndUpdate to avoid VersionError
    await JobDescription.findByIdAndUpdate(jdId, {
      $set: {
        assessmentSets: generatedSets,
        status: 'ready'
      }
    });

    console.log(`✅ All ${numberOfSets} sets generated for JD: ${jdId}`);
    return { success: true, sets: generatedSets };

  } catch (error) {
    console.error('❌ Error generating question sets:', error);

    // Update JD status to indicate error without using .save()
    await JobDescription.findByIdAndUpdate(jdId, {
      $set: { status: 'parsed' },
      $push: { 'parsingMeta.parseErrors': error.message }
    });

    return { success: false, error: error.message };
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

Return a JSON object with a "questions" key containing an array of questions:
{
  "questions": [
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
}

IMPORTANT: You MUST use the exact keys: "questionId", "questionText", "options", "skill", "difficulty", "points", "explanation".
Return ONLY valid JSON.`;

  try {
    const response = await callOpenAI(prompt, process.env.OPENAI_QUESTION_GEN_MODEL || 'gpt-4o', true);
    console.log('🔹 Objective Questions Response:', JSON.stringify(response, null, 2));

    // Handle both array and object responses for robustness
    let questions = [];
    if (Array.isArray(response)) {
      questions = response;
    } else if (response.questions && Array.isArray(response.questions)) {
      questions = response.questions;
    } else {
      // Try to find any array in the object
      const values = Object.values(response);
      const arrayVal = values.find(v => Array.isArray(v));
      if (arrayVal) questions = arrayVal;
    }

    // Validate and fix strict schema issues
    questions = questions.map((q, i) => ({
      ...q,
      questionId: q.questionId || `obj_${i + 1}`,
      questionText: q.questionText || q.text || q.question || "Question text missing",
      points: q.points || 1,
      difficulty: q.difficulty || "medium"
    }));

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

Return a JSON object with a "questions" key containing an array of questions:
{
  "questions": [
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
}

IMPORTANT: You MUST use the exact keys: "questionId", "questionText", "expectedAnswer", "rubric", "skill", "difficulty", "points", "maxWords".
Return ONLY valid JSON.`;

  try {
    const response = await callOpenAI(prompt, process.env.OPENAI_QUESTION_GEN_MODEL || 'gpt-4o', true);
    console.log('🔹 Subjective Questions Response:', JSON.stringify(response, null, 2));

    let questions = [];
    if (Array.isArray(response)) {
      questions = response;
    } else if (response.questions && Array.isArray(response.questions)) {
      questions = response.questions;
    } else {
      const values = Object.values(response);
      const arrayVal = values.find(v => Array.isArray(v));
      if (arrayVal) questions = arrayVal;
    }

    // Validate and fix strict schema issues
    questions = questions.map((q, i) => ({
      ...q,
      questionId: q.questionId || `sub_${i + 1}`,
      questionText: q.questionText || q.text || q.question || "Question text missing",
      points: q.points || 10,
      difficulty: q.difficulty || "medium"
    }));

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

Return a JSON object with a "questions" key containing an array of questions:
{
  "questions": [
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
}

IMPORTANT: You MUST use the exact keys: "questionId", "title", "questionText", "description", "testCases", "input", "expectedOutput".
Return ONLY valid JSON.`;

  try {
    const response = await callOpenAI(prompt, process.env.OPENAI_QUESTION_GEN_MODEL || 'gpt-4o', true);
    console.log('🔹 Programming Questions Response:', JSON.stringify(response, null, 2));

    let questions = [];
    if (Array.isArray(response)) {
      questions = response;
    } else if (response.questions && Array.isArray(response.questions)) {
      questions = response.questions;
    } else {
      const values = Object.values(response);
      const arrayVal = values.find(v => Array.isArray(v));
      if (arrayVal) questions = arrayVal;
    }

    // Validate and fix strict schema issues
    questions = questions.map((q, i) => ({
      ...q,
      questionId: q.questionId || `prog_${i + 1}`,
      questionText: q.questionText || q.question || q.text || "Question text missing",
      title: q.title || "Untitled Problem",
      testCases: (q.testCases || []).map(tc => ({
        ...tc,
        expectedOutput: tc.expectedOutput || tc.output || ""
      })),
      points: q.points || 20,
      difficulty: q.difficulty || "medium"
    }));

    return { success: true, questions };
  } catch (error) {
    console.error('❌ Error generating programming questions:', error);
    return { success: false, error: error.message };
  }
}

export default router;
