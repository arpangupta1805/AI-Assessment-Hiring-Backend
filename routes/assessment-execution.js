import express from 'express';
import { body, validationResult } from 'express-validator';
import CandidateAssessment from '../models/CandidateAssessment.js';
import AssessmentSet from '../models/AssessmentSet.js';
import AssessmentAnswer from '../models/AssessmentAnswer.js';
import ProctoringEvent from '../models/ProctoringEvent.js';
import { runEvaluation } from './evaluation.js';

const router = express.Router();

// ============================================================================
// SESSION MIDDLEWARE - Validate session token
// ============================================================================

async function validateSession(req, res, next) {
    try {
        const sessionToken = req.headers['x-session-token'] || req.body.sessionToken;

        if (!sessionToken) {
            return res.status(401).json({
                success: false,
                error: 'Session token required',
            });
        }

        const candidateAssessment = await CandidateAssessment.findOne({ sessionToken })
            .populate('jd', 'assessmentConfig parsedContent.roleTitle')
            .populate('assignedSet');

        if (!candidateAssessment) {
            return res.status(401).json({
                success: false,
                error: 'Invalid session',
            });
        }

        if (candidateAssessment.status !== 'in_progress') {
            return res.status(400).json({
                success: false,
                error: 'Assessment is not in progress',
                status: candidateAssessment.status,
            });
        }

        // Check time limit
        const startTime = candidateAssessment.startedAt;
        const totalTimeMs = candidateAssessment.jd.assessmentConfig.totalTimeMinutes * 60 * 1000;
        const elapsed = Date.now() - startTime.getTime();

        if (elapsed > totalTimeMs + 60000) { // 1 minute grace period
            candidateAssessment.status = 'submitted';
            candidateAssessment.submittedAt = new Date();
            await candidateAssessment.save();

            return res.status(400).json({
                success: false,
                error: 'Assessment time expired',
            });
        }

        // Update heartbeat
        candidateAssessment.lastHeartbeat = new Date();
        await candidateAssessment.save();

        req.candidateAssessment = candidateAssessment;
        req.remainingTime = totalTimeMs - elapsed;
        next();
    } catch (error) {
        console.error('❌ Session validation error:', error);
        res.status(500).json({
            success: false,
            error: 'Session validation failed',
        });
    }
}

// ============================================================================
// SESSION ROUTES
// ============================================================================

/**
 * GET /api/assessment/session
 * Get current session state
 */
router.get('/session', validateSession, async (req, res) => {
    try {
        const { candidateAssessment, remainingTime } = req;
        const set = candidateAssessment.assignedSet;

        res.json({
            success: true,
            data: {
                startedAt: candidateAssessment.startedAt,
                remainingTimeMs: remainingTime,
                currentSection: candidateAssessment.currentSection,
                sectionProgress: candidateAssessment.sectionProgress,
                sections: {
                    objective: {
                        enabled: candidateAssessment.jd.assessmentConfig.sections.objective.enabled,
                        totalQuestions: set?.objectiveQuestions?.length || 0,
                        timeMinutes: candidateAssessment.jd.assessmentConfig.sections.objective.timeMinutes,
                    },
                    subjective: {
                        enabled: candidateAssessment.jd.assessmentConfig.sections.subjective.enabled,
                        totalQuestions: set?.subjectiveQuestions?.length || 0,
                        timeMinutes: candidateAssessment.jd.assessmentConfig.sections.subjective.timeMinutes,
                    },
                    programming: {
                        enabled: candidateAssessment.jd.assessmentConfig.sections.programming.enabled,
                        totalQuestions: set?.programmingQuestions?.length || 0,
                        timeMinutes: candidateAssessment.jd.assessmentConfig.sections.programming.timeMinutes,
                    },
                },
            },
        });
    } catch (error) {
        console.error('❌ Get session error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get session',
        });
    }
});

/**
 * GET /api/assessment/questions/:section
 * Get questions for a specific section
 */
router.get('/questions/:section', validateSession, async (req, res) => {
    try {
        const { section } = req.params;
        const { candidateAssessment } = req;
        const set = candidateAssessment.assignedSet;

        if (!['objective', 'subjective', 'programming'].includes(section)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid section',
            });
        }

        // Check if section is enabled
        if (!candidateAssessment.jd.assessmentConfig.sections[section].enabled) {
            return res.status(400).json({
                success: false,
                error: 'Section is not enabled',
            });
        }

        // Mark section as started
        if (!candidateAssessment.sectionProgress[section].started) {
            candidateAssessment.sectionProgress[section].started = true;
            candidateAssessment.sectionProgress[section].startedAt = new Date();
            candidateAssessment.currentSection = section;
            await candidateAssessment.save();
        }

        // Get questions (hide correct answers for objective, hide full answers for subjective)
        let questions = [];

        if (section === 'objective') {
            questions = set.objectiveQuestions.map(q => ({
                questionId: q.questionId,
                questionText: q.questionText,
                options: q.options.map(o => ({ text: o.text })), // Hide isCorrect
                skill: q.skill,
                difficulty: q.difficulty,
                points: q.points,
            }));
        } else if (section === 'subjective') {
            questions = set.subjectiveQuestions.map(q => ({
                questionId: q.questionId,
                questionText: q.questionText,
                skill: q.skill,
                difficulty: q.difficulty,
                points: q.points,
                maxWords: q.maxWords,
            }));
        } else if (section === 'programming') {
            questions = set.programmingQuestions.map(q => ({
                questionId: q.questionId,
                title: q.title,
                questionText: q.questionText,
                description: q.description,
                constraints: q.constraints,
                sampleInput: q.sampleInput,
                sampleOutput: q.sampleOutput,
                skill: q.skill,
                difficulty: q.difficulty,
                points: q.points,
                allowedLanguages: q.allowedLanguages,
                timeLimit: q.timeLimit,
                memoryLimit: q.memoryLimit,
                // Only show sample test cases
                testCases: q.testCases.filter(tc => tc.isSample).map(tc => ({
                    input: tc.input,
                    expectedOutput: tc.expectedOutput,
                })),
                starterCode: q.starterCode,
            }));
        }

        // Get saved answers if any
        const savedAnswers = await AssessmentAnswer.findOne({
            candidateAssessment: candidateAssessment._id,
            section,
        });

        res.json({
            success: true,
            data: {
                section,
                questions,
                totalQuestions: questions.length,
                timeMinutes: candidateAssessment.jd.assessmentConfig.sections[section].timeMinutes,
                savedAnswers: savedAnswers ? {
                    objective: savedAnswers.objectiveAnswers,
                    subjective: savedAnswers.subjectiveAnswers,
                    programming: savedAnswers.programmingAnswers,
                }[section] : [],
            },
        });
    } catch (error) {
        console.error('❌ Get questions error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get questions',
        });
    }
});

/**
 * POST /api/assessment/save-answer
 * Auto-save a single answer
 */
router.post('/save-answer', validateSession, [
    body('section').isIn(['objective', 'subjective', 'programming']),
    body('questionId').notEmpty(),
    body('answer').exists(),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { section, questionId, answer, code, language } = req.body;
        const { candidateAssessment } = req;

        // Find or create answer document
        let answerDoc = await AssessmentAnswer.findOne({
            candidateAssessment: candidateAssessment._id,
            section,
        });

        if (!answerDoc) {
            answerDoc = new AssessmentAnswer({
                candidateAssessment: candidateAssessment._id,
                section,
                sectionStartedAt: new Date(),
            });
        }

        const now = new Date();

        if (section === 'objective') {
            const existingIdx = answerDoc.objectiveAnswers.findIndex(a => a.questionId === questionId);
            const answerData = {
                questionId,
                selectedOptionIndex: answer.selectedOptionIndex,
                selectedOptionText: answer.selectedOptionText || '',
                answeredAt: now,
            };

            if (existingIdx >= 0) {
                answerDoc.objectiveAnswers[existingIdx] = {
                    ...answerDoc.objectiveAnswers[existingIdx],
                    ...answerData,
                };
            } else {
                answerDoc.objectiveAnswers.push(answerData);
            }
        } else if (section === 'subjective') {
            const existingIdx = answerDoc.subjectiveAnswers.findIndex(a => a.questionId === questionId);
            const answerData = {
                questionId,
                answer: answer || '',
                wordCount: answer ? answer.split(/\s+/).filter(w => w).length : 0,
                answeredAt: now,
                lastSavedAt: now,
            };

            if (existingIdx >= 0) {
                answerDoc.subjectiveAnswers[existingIdx] = {
                    ...answerDoc.subjectiveAnswers[existingIdx],
                    ...answerData,
                };
            } else {
                answerDoc.subjectiveAnswers.push(answerData);
            }
        } else if (section === 'programming') {
            const existingIdx = answerDoc.programmingAnswers.findIndex(a => a.questionId === questionId);
            const answerData = {
                questionId,
                code: code || '',
                language: language || 'python',
                answeredAt: now,
                lastSavedAt: now,
            };

            if (existingIdx >= 0) {
                answerDoc.programmingAnswers[existingIdx] = {
                    ...answerDoc.programmingAnswers[existingIdx],
                    ...answerData,
                };
            } else {
                answerDoc.programmingAnswers.push(answerData);
            }
        }

        await answerDoc.save();

        // Update section progress
        const counts = {
            objective: answerDoc.objectiveAnswers.length,
            subjective: answerDoc.subjectiveAnswers.length,
            programming: answerDoc.programmingAnswers.length,
        };

        candidateAssessment.sectionProgress[section].questionsAnswered = counts[section];
        await candidateAssessment.save();

        res.json({
            success: true,
            message: 'Answer saved',
            data: {
                savedAt: now,
                questionsAnswered: counts[section],
            },
        });
    } catch (error) {
        console.error('❌ Save answer error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save answer',
        });
    }
});

/**
 * POST /api/assessment/submit-section/:section
 * Submit a section
 */
router.post('/submit-section/:section', validateSession, async (req, res) => {
    try {
        const { section } = req.params;
        const { candidateAssessment } = req;

        if (!['objective', 'subjective', 'programming'].includes(section)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid section',
            });
        }

        // Get answer document
        const answerDoc = await AssessmentAnswer.findOne({
            candidateAssessment: candidateAssessment._id,
            section,
        });

        if (answerDoc) {
            answerDoc.sectionSubmittedAt = new Date();
            answerDoc.isSubmitted = true;

            // Calculate time spent
            if (answerDoc.sectionStartedAt) {
                answerDoc.totalTimeSpentSeconds = Math.floor(
                    (answerDoc.sectionSubmittedAt - answerDoc.sectionStartedAt) / 1000
                );
            }

            // For objective, grade immediately
            if (section === 'objective') {
                const set = candidateAssessment.assignedSet;
                answerDoc.objectiveAnswers.forEach(ans => {
                    const question = set.objectiveQuestions.find(q => q.questionId === ans.questionId);
                    if (question) {
                        const correctOption = question.options.find(o => o.isCorrect);
                        ans.isCorrect = ans.selectedOptionIndex >= 0 &&
                            question.options[ans.selectedOptionIndex]?.isCorrect === true;
                        ans.points = ans.isCorrect ? question.points : 0;
                    }
                });
                answerDoc.calculateScore();
            }

            await answerDoc.save();
        }

        // Update section progress
        candidateAssessment.sectionProgress[section].completed = true;
        candidateAssessment.sectionProgress[section].completedAt = new Date();

        // Determine next section
        const sectionOrder = ['objective', 'subjective', 'programming'];
        const currentIdx = sectionOrder.indexOf(section);
        let nextSection = null;

        for (let i = currentIdx + 1; i < sectionOrder.length; i++) {
            if (candidateAssessment.jd.assessmentConfig.sections[sectionOrder[i]].enabled) {
                nextSection = sectionOrder[i];
                break;
            }
        }

        candidateAssessment.currentSection = nextSection;
        await candidateAssessment.save();

        res.json({
            success: true,
            message: 'Section submitted',
            data: {
                section,
                nextSection,
                isLastSection: !nextSection,
            },
        });
    } catch (error) {
        console.error('❌ Submit section error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to submit section',
        });
    }
});

/**
 * POST /api/assessment/submit-all
 * Submit entire assessment
 */
router.post('/submit-all', validateSession, async (req, res) => {
    try {
        const { candidateAssessment } = req;

        // Calculate total time spent
        const timeSpentSeconds = Math.floor(
            (Date.now() - candidateAssessment.startedAt.getTime()) / 1000
        );

        // Update candidate assessment
        candidateAssessment.status = 'submitted';
        candidateAssessment.submittedAt = new Date();
        candidateAssessment.timeSpentSeconds = timeSpentSeconds;
        candidateAssessment.currentSection = null;
        await candidateAssessment.save();

        // Create synchronous evaluation
        // User wants to wait for the report to be generated before seeing the success page
        console.log(`⏳ Starting synchronous evaluation for ${candidateAssessment._id}...`);
        try {
            await runEvaluation(candidateAssessment._id);
            console.log(`✅ Synchronous evaluation complete for ${candidateAssessment._id}`);
        } catch (evalErr) {
            console.error('❌ Synchronous evaluation failed (submission still successful):', evalErr);
            // We don't fail the request, just log it. The user has submitted successfully.
        }

        res.json({
            success: true,
            message: 'Assessment submitted successfully',
            data: {
                submittedAt: candidateAssessment.submittedAt,
                timeSpentSeconds,
            },
        });

        // Update JD stats
        const JobDescription = (await import('../models/JobDescription.js')).default;
        await JobDescription.findByIdAndUpdate(candidateAssessment.jd._id, {
            $inc: { 'stats.completedAssessments': 1 },
        });
    } catch (error) {
        console.error('❌ Submit all error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to submit assessment',
        });
    }
});

/**
 * POST /api/assessment/heartbeat
 * Session heartbeat
 */
router.post('/heartbeat', validateSession, async (req, res) => {
    res.json({
        success: true,
        data: {
            remainingTimeMs: req.remainingTime,
            lastHeartbeat: req.candidateAssessment.lastHeartbeat,
        },
    });
});

// ============================================================================
// PROCTORING ROUTES
// ============================================================================

/**
 * POST /api/assessment/proctoring/event
 * Log a proctoring event
 */
router.post('/proctoring/event', validateSession, [
    body('eventType').isIn([
        'tab_switch', 'window_blur', 'multiple_faces', 'no_face', 'face_not_centered',
        'device_detected', 'external_screen', 'copy_paste', 'right_click',
        'keyboard_shortcut', 'idle', 'suspicious_behavior', 'browser_resize',
        'fullscreen_exit', 'dev_tools', 'camera_denied', 'fullscreen_failed',
        'copy_attempt', 'paste_attempt', 'cut_attempt', 'assessment_completed',
        'periodic_check',
    ]).withMessage('Invalid event type'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { eventType, screenshot, evidence, duration, context } = req.body;
        const { candidateAssessment } = req;

        // Determine severity
        const severity = ProctoringEvent.getSeverityForEvent(eventType);

        // Create proctoring event
        const event = await ProctoringEvent.create({
            candidateAssessment: candidateAssessment._id,
            eventType,
            severity,
            screenshot: screenshot || '',
            evidence: evidence || {},
            duration: duration || 0,
            context: context || {},
        });

        // Update candidate assessment proctoring stats
        candidateAssessment.proctoringStats.totalEvents += 1;
        if (severity === 'high') {
            candidateAssessment.proctoringStats.highSeverityEvents += 1;
            candidateAssessment.integrityStatus = 'FLAGGED_UNDER_REVIEW';
        }
        if (eventType === 'tab_switch') {
            candidateAssessment.proctoringStats.tabSwitches += 1;
        }
        if (['multiple_faces', 'no_face', 'face_not_centered'].includes(eventType)) {
            candidateAssessment.proctoringStats.faceDetectionIssues += 1;
        }

        await candidateAssessment.save();

        res.json({
            success: true,
            data: {
                eventId: event._id,
                severity,
            },
        });
    } catch (error) {
        console.error('❌ Log proctoring event error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to log event',
        });
    }
});

export default router;
