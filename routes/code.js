import express from 'express';
import { body, validationResult } from 'express-validator';
import CandidateAssessment from '../models/CandidateAssessment.js';
import AssessmentAnswer from '../models/AssessmentAnswer.js';
import judge0Service from '../services/judge0Service.js';

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
            });
        }

        req.candidateAssessment = candidateAssessment;
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
// CODE EXECUTION ROUTES
// ============================================================================

/**
 * POST /api/code/run
 * Run code against sample test cases only
 * This is for candidates to test their code before final submission
 */
router.post('/run', validateSession, [
    body('questionId').notEmpty().withMessage('Question ID required'),
    body('code').notEmpty().withMessage('Code required'),
    body('language').notEmpty().withMessage('Language required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { questionId, code, language } = req.body;
        const { candidateAssessment } = req;
        const set = candidateAssessment.assignedSet;

        // Find the question
        const question = set.programmingQuestions.find(q => q.questionId === questionId);
        if (!question) {
            return res.status(404).json({
                success: false,
                error: 'Question not found',
            });
        }

        // Check if language is allowed
        if (!question.allowedLanguages.includes(language)) {
            return res.status(400).json({
                success: false,
                error: `Language ${language} is not allowed. Allowed: ${question.allowedLanguages.join(', ')}`,
            });
        }

        // Get sample test cases only
        const sampleTestCases = question.testCases.filter(tc => tc.isSample);

        if (sampleTestCases.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No sample test cases available',
            });
        }

        // Get language ID for Judge0
        const languageId = judge0Service.getLanguageId(language);
        if (!languageId) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported language',
            });
        }

        // Prepare test cases
        const testCasesToRun = sampleTestCases.map((tc, idx) => ({
            number: idx + 1,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
        }));

        // Run code against test cases
        const results = await judge0Service.runTestCases(code, languageId, testCasesToRun);

        // Format results
        const testResults = results.map((r, idx) => ({
            testNumber: idx + 1,
            input: sampleTestCases[idx].input,
            expectedOutput: sampleTestCases[idx].expectedOutput,
            actualOutput: r.actualOutput || '',
            passed: r.passed,
            executionTime: r.executionTime,
            memoryUsed: r.memoryUsed,
            error: r.error || '',
        }));

        const passed = testResults.filter(r => r.passed).length;
        const total = testResults.length;

        // Save run to answer history
        let answerDoc = await AssessmentAnswer.findOne({
            candidateAssessment: candidateAssessment._id,
            section: 'programming',
        });

        if (!answerDoc) {
            answerDoc = new AssessmentAnswer({
                candidateAssessment: candidateAssessment._id,
                section: 'programming',
                sectionStartedAt: new Date(),
            });
        }

        // Update or add programming answer
        const existingIdx = answerDoc.programmingAnswers.findIndex(a => a.questionId === questionId);
        if (existingIdx >= 0) {
            answerDoc.programmingAnswers[existingIdx].code = code;
            answerDoc.programmingAnswers[existingIdx].language = language;
            answerDoc.programmingAnswers[existingIdx].lastSavedAt = new Date();
            answerDoc.programmingAnswers[existingIdx].runHistory.push({
                code,
                language,
                testsPassed: passed,
                totalTests: total,
                ranAt: new Date(),
            });
        } else {
            answerDoc.programmingAnswers.push({
                questionId,
                code,
                language,
                answeredAt: new Date(),
                lastSavedAt: new Date(),
                runHistory: [{
                    code,
                    language,
                    testsPassed: passed,
                    totalTests: total,
                    ranAt: new Date(),
                }],
            });
        }

        await answerDoc.save();

        res.json({
            success: true,
            data: {
                testResults,
                passed,
                total,
                allPassed: passed === total,
            },
        });
    } catch (error) {
        console.error('❌ Run code error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to run code',
            message: error.message,
        });
    }
});

/**
 * POST /api/code/submit
 * Final code submission - runs against ALL test cases (including hidden)
 */
router.post('/submit', validateSession, [
    body('questionId').notEmpty().withMessage('Question ID required'),
    body('code').notEmpty().withMessage('Code required'),
    body('language').notEmpty().withMessage('Language required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { questionId, code, language } = req.body;
        const { candidateAssessment } = req;
        const set = candidateAssessment.assignedSet;

        // Find the question
        const question = set.programmingQuestions.find(q => q.questionId === questionId);
        if (!question) {
            return res.status(404).json({
                success: false,
                error: 'Question not found',
            });
        }

        // Check if language is allowed
        if (!question.allowedLanguages.includes(language)) {
            return res.status(400).json({
                success: false,
                error: `Language ${language} is not allowed`,
            });
        }

        // Get language ID
        const languageId = judge0Service.getLanguageId(language);
        if (!languageId) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported language',
            });
        }

        // Get ALL test cases
        const allTestCases = question.testCases;

        if (allTestCases.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No test cases available',
            });
        }

        // Prepare test cases
        const testCasesToRun = allTestCases.map((tc, idx) => ({
            number: idx + 1,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
            weight: tc.weight || 1,
        }));

        // Run code against all test cases
        const results = await judge0Service.runTestCases(code, languageId, testCasesToRun);

        // Format and calculate results
        const testCaseResults = results.map((r, idx) => ({
            testCaseIndex: idx,
            input: allTestCases[idx].input,
            expectedOutput: allTestCases[idx].expectedOutput,
            actualOutput: r.actualOutput || '',
            passed: r.passed,
            executionTime: r.executionTime,
            memoryUsed: r.memoryUsed,
            error: r.error || '',
            isHidden: allTestCases[idx].isHidden,
        }));

        const testCasesPassed = testCaseResults.filter(r => r.passed).length;
        const totalTestCases = testCaseResults.length;
        const allPassed = testCasesPassed === totalTestCases;

        // Calculate weighted score
        let weightedScore = 0;
        let totalWeight = 0;
        testCaseResults.forEach((r, idx) => {
            const weight = allTestCases[idx].weight || 1;
            totalWeight += weight;
            if (r.passed) {
                weightedScore += weight;
            }
        });

        const correctnessScore = totalWeight > 0 ? (weightedScore / totalWeight) * 100 : 0;

        // Update answer document
        let answerDoc = await AssessmentAnswer.findOne({
            candidateAssessment: candidateAssessment._id,
            section: 'programming',
        });

        if (!answerDoc) {
            answerDoc = new AssessmentAnswer({
                candidateAssessment: candidateAssessment._id,
                section: 'programming',
                sectionStartedAt: new Date(),
            });
        }

        const existingIdx = answerDoc.programmingAnswers.findIndex(a => a.questionId === questionId);
        const answerData = {
            questionId,
            code,
            language,
            testCaseResults: testCaseResults.map(r => ({
                testCaseIndex: r.testCaseIndex,
                input: r.isHidden ? '[hidden]' : r.input,
                expectedOutput: r.isHidden ? '[hidden]' : r.expectedOutput,
                actualOutput: r.actualOutput,
                passed: r.passed,
                executionTime: r.executionTime,
                memoryUsed: r.memoryUsed,
                error: r.error,
                isHidden: r.isHidden,
            })),
            testCasesPassed,
            totalTestCases,
            allPassed,
            correctnessScore,
            submittedAt: new Date(),
            lastSavedAt: new Date(),
        };

        if (existingIdx >= 0) {
            answerDoc.programmingAnswers[existingIdx] = {
                ...answerDoc.programmingAnswers[existingIdx],
                ...answerData,
            };
        } else {
            answerDoc.programmingAnswers.push({
                ...answerData,
                answeredAt: new Date(),
                runHistory: [],
            });
        }

        await answerDoc.save();

        // Return results (hide hidden test case details)
        res.json({
            success: true,
            data: {
                testCasesPassed,
                totalTestCases,
                allPassed,
                correctnessScore,
                // Only show sample test case results to candidate
                visibleResults: testCaseResults.filter(r => !r.isHidden).map(r => ({
                    input: r.input,
                    expectedOutput: r.expectedOutput,
                    actualOutput: r.actualOutput,
                    passed: r.passed,
                    executionTime: r.executionTime,
                    error: r.error,
                })),
                hiddenTestsPassed: testCaseResults.filter(r => r.isHidden && r.passed).length,
                hiddenTestsTotal: testCaseResults.filter(r => r.isHidden).length,
            },
        });
    } catch (error) {
        console.error('❌ Submit code error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to submit code',
            message: error.message,
        });
    }
});

/**
 * GET /api/code/languages
 * Get list of supported languages
 */
router.get('/languages', async (req, res) => {
    try {
        const languages = judge0Service.getSupportedLanguages();
        res.json({
            success: true,
            data: languages,
        });
    } catch (error) {
        console.error('❌ Get languages error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get languages',
        });
    }
});

export default router;
