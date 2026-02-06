import express from 'express';
import OASession from '../models/OASession.js';
import OAAttempt from '../models/OAAttempt.js';
import PracticeAttempt from '../models/PracticeAttempt.js';
import OAcompany from '../models/oacompany.js';
import OAquestions from '../models/oaquestions.js';
import judge0Service from '../services/judge0Service.js';
import oaScoringService from '../services/oaScoringService.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/oa/companies
 * Get all companies with their question counts
 */
router.get('/companies', authenticateToken, async (req, res) => {
    try {
        const companies = await OAcompany.find().select('-__v');
        
        const companiesWithCounts = await Promise.all(
            companies.map(async (company) => {
                const questionCounts = await OAquestions.aggregate([
                    { $match: { company: company.company_name } },
                    { $group: { _id: '$difficulty', count: { $sum: 1 } } },
                ]);

                const counts = {
                    easy: 0,
                    medium: 0,
                    hard: 0,
                    expert: 0,
                };

                questionCounts.forEach(item => {
                    counts[item._id] = item.count;
                });

                return {
                    _id: company._id,
                    name: company.company_name,
                    about: company.about_company,
                    totalQuestions: company.questionids.length,
                    questionCounts: counts,
                };
            })
        );

        res.json({ success: true, companies: companiesWithCounts });
    } catch (error) {
        console.error('Error fetching companies:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch companies' });
    }
});

/**
 * GET /api/oa/questions
 * Get practice questions with filters
 */
router.get('/questions', authenticateToken, async (req, res) => {
    try {
        const { company, role, difficulty, page = 1, limit = 20 } = req.query;

        const filter = {};
        if (company) filter.company = company;
        if (role) filter.role = role;
        if (difficulty) filter.difficulty = difficulty;

        const skip = (page - 1) * limit;

        const questions = await OAquestions.find(filter)
            .select('-hidden_testcases -edge_testcases -optimal_solution')
            .skip(skip)
            .limit(parseInt(limit))
            .sort({ createdAt: -1 });

        const total = await OAquestions.countDocuments(filter);

        // Get user's solved questions
        const userId = req.user.userId;
        const solvedQuestions = await PracticeAttempt.distinct('questionId', {
            userId,
            isSolved: true,
        });

        const questionsWithStatus = questions.map(q => ({
            ...q.toObject(),
            isSolved: solvedQuestions.includes(q.questionid),
        }));

        res.json({
            success: true,
            questions: questionsWithStatus,
            pagination: {
                current: parseInt(page),
                total: Math.ceil(total / limit),
                count: questions.length,
                totalQuestions: total,
            },
        });
    } catch (error) {
        console.error('Error fetching questions:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch questions' });
    }
});

/**
 * GET /api/oa/question/:questionId
 * Get a specific question for practice
 */
router.get('/question/:questionId', authenticateToken, async (req, res) => {
    try {
        const { questionId } = req.params;
        const question = await OAquestions.findOne({ questionid: questionId })
            .select('-hidden_testcases -edge_testcases');

        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found' });
        }

        // Get user's attempts for this question
        const userId = req.user.userId;
        const attempts = await PracticeAttempt.find({ userId, questionId })
            .sort({ attemptNumber: -1 })
            .limit(10);

        const isSolved = attempts.some(a => a.isSolved);

        const questionObj = question.toObject();
        
        // Convert Map to plain object for JSON serialization
        if (questionObj.visible_testcases instanceof Map) {
            questionObj.visible_testcases = Object.fromEntries(questionObj.visible_testcases);
        }

        res.json({
            success: true,
            question: questionObj,
            attempts,
            isSolved,
            totalAttempts: attempts.length,
        });
    } catch (error) {
        console.error('Error fetching question:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch question' });
    }
});

/**
 * GET /api/oa/available-questions
 * Check how many questions are available for given criteria
 */
router.get('/available-questions', authenticateToken, async (req, res) => {
    try {
        const { company, role, difficulty } = req.query;

        if (!company || !role || !difficulty) {
            return res.status(400).json({ 
                success: false, 
                message: 'Company, role, and difficulty are required' 
            });
        }

        const filter = { company, role, difficulty };
        const count = await OAquestions.countDocuments(filter);

        res.json({ 
            success: true, 
            availableQuestions: count,
            company,
            role,
            difficulty
        });
    } catch (error) {
        console.error('Error checking available questions:', error);
        res.status(500).json({ success: false, message: 'Failed to check available questions' });
    }
});

/**
 * POST /api/oa/session/start
 * Start a new OA session with questions fetched from database
 */
router.post('/session/start', authenticateToken, async (req, res) => {
    try {
        const { company, role, questionCount = 2, difficulty = 'medium' } = req.body;
        const userId = req.user.userId;

        // Validate questionCount
        if (questionCount < 1 || questionCount > 5) {
            return res.status(400).json({ 
                success: false, 
                message: 'Question count must be between 1 and 5' 
            });
        }

        // Validate difficulty
        const validDifficulties = ['easy', 'medium', 'hard', 'expert'];
        if (!validDifficulties.includes(difficulty)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid difficulty. Must be easy, medium, hard, or expert'
            });
        }

        // Get company info
        const companyData = await OAcompany.findOne({ company_name: company });
        if (!companyData) {
            return res.status(404).json({ success: false, message: 'Company not found' });
        }

        console.log(`🎯 Starting OA session: ${questionCount} ${difficulty} questions for ${company} (${role})`);

        // Fetch questions from database instead of generating with AI
        console.log(`📚 Fetching questions from database...`);
        
        const filter = {
            company: company,
            role: role,
            difficulty: difficulty
        };

        // Get total available questions with these filters
        const totalAvailable = await OAquestions.countDocuments(filter);
        console.log(`� Found ${totalAvailable} questions matching criteria`);

        if (totalAvailable === 0) {
            return res.status(404).json({ 
                success: false, 
                message: `No questions found for ${company} - ${role} - ${difficulty}. Please try different criteria.` 
            });
        }

        if (totalAvailable < questionCount) {
            return res.status(400).json({ 
                success: false, 
                message: `Only ${totalAvailable} questions available for ${company} - ${role} - ${difficulty}. Please select ${totalAvailable} or fewer questions.`,
                availableQuestions: totalAvailable
            });
        }

        // Randomly select questions from the available pool
        // Using MongoDB's $sample aggregation for efficient random selection
        const dbQuestions = await OAquestions.aggregate([
            { $match: filter },
            { $sample: { size: questionCount } }
        ]);

        console.log(`✅ Successfully fetched ${dbQuestions.length} random questions from database`);

        // Transform database questions to match the format expected by OASession
        const generatedQuestions = dbQuestions.map(q => ({
            questionId: q.questionid,
            questionText: q.questiontxt,
            difficulty: q.difficulty,
            estimatedTime: q.estimated_time,
            constraints: q.constraints,
            visibleTestcases: q.visible_testcases,
            hiddenTestcases: q.hidden_testcases,
            edgeTestcases: q.edge_testcases,
            howToApproach: q.howtoapproach,
            // Only include the canonical optimal solution from the question bank.
            optimalSolution: q.optimal_solution,
        }));

        // Create OA session
        const session = new OASession({
            userId,
            company,
            role,
            questions: generatedQuestions.map(q => ({
                questionId: q.questionId,
                questionText: q.questionText,
                difficulty: q.difficulty,
                estimatedTime: q.estimatedTime,
                constraints: q.constraints,
                visibleTestcases: q.visibleTestcases,
                hiddenTestcases: q.hiddenTestcases,
                edgeTestcases: q.edgeTestcases,
                howToApproach: q.howToApproach,
                optimalSolution: q.optimalSolution,
            })),
        });

        await session.save();

        // Return session without hidden/edge test cases
        const sessionResponse = session.toObject();
        sessionResponse.questions = sessionResponse.questions.map(q => {
            const { hiddenTestcases, edgeTestcases, optimalSolution, ...rest } = q;
            return rest;
        });

        res.json({ success: true, session: sessionResponse });
    } catch (error) {
        console.error('Error starting OA session:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Failed to start OA session',
            error: error.message 
        });
    }
});

/**
 * GET /api/oa/session/:sessionId
 * Get OA session details
 */
router.get('/session/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.user.userId;

        const session = await OASession.findOne({ _id: sessionId, userId });

        if (!session) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        // Hide sensitive data
        const sessionResponse = session.toObject();
        sessionResponse.questions = sessionResponse.questions.map(q => {
            const { hiddenTestcases, edgeTestcases, optimalSolution, ...rest } = q;
            
            // Convert Map to plain object for visibleTestcases
            if (rest.visibleTestcases instanceof Map) {
                rest.visibleTestcases = Object.fromEntries(rest.visibleTestcases);
            }
            
            return rest;
        });

        res.json({ success: true, session: sessionResponse });
    } catch (error) {
        console.error('Error fetching session:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch session' });
    }
});

/**
 * POST /api/oa/session/:sessionId/run
 * Run code for a question in OA session
 */
router.post('/session/:sessionId/run', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { questionId, code, language } = req.body;
        const userId = req.user.userId;

        // Validate inputs
        if (!code || !language) {
            return res.status(400).json({ success: false, message: 'Code and language are required' });
        }

        // Get session
        const session = await OASession.findOne({ _id: sessionId, userId });
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        // Get question from session
        const question = session.questions.find(q => q.questionId === questionId);
        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found in session' });
        }

        // Get language ID
        const languageId = judge0Service.getLanguageId(language);

        // Helper function to convert Map or object to entries
        const getTestCaseEntries = (testcaseData) => {
            if (!testcaseData) return [];
            if (testcaseData instanceof Map) {
                return Array.from(testcaseData.entries());
            }
            const obj = typeof testcaseData.toObject === 'function' ? testcaseData.toObject() : testcaseData;
            return Object.entries(obj);
        };

        // Prepare test cases (visible only for run)
        const testCases = [];
        const visibleEntries = getTestCaseEntries(question.visibleTestcases);
        console.log(`📝 [Session Run] Processing ${visibleEntries.length} visible test cases`);
        
        let testNumber = 1;
        for (const [key, value] of visibleEntries) {
            if (value && (value.input !== undefined || value.output !== undefined)) {
                testCases.push({
                    type: 'visible',
                    number: testNumber++,
                    input: value.input || '',
                    expectedOutput: value.output || '',
                });
            }
        }

        console.log(`✅ [Session Run] Total test cases prepared: ${testCases.length}`);

        // Run test cases
        const testResults = await judge0Service.runTestCases(code, languageId, testCases);

        // Calculate attempt number
        const attemptCount = await OAAttempt.countDocuments({ sessionId, questionId });
        const attemptNumber = attemptCount + 1;

        // Save attempt
        const attempt = new OAAttempt({
            sessionId,
            userId,
            questionId,
            code,
            language,
            languageId,
            status: testResults.every(t => t.passed) ? 'success' : 'failed',
            testResults,
            visibleTestsPassed: testResults.filter(t => t.passed).length,
            totalTestsPassed: testResults.filter(t => t.passed).length,
            totalTests: testResults.length,
            allTestsPassed: testResults.every(t => t.passed),
            attemptNumber,
        });

        await attempt.save();

        // Update session question attempt count and latest attempt
        question.attemptCount = attemptNumber;
        question.latestAttemptId = attempt._id;
        await session.save();

        res.json({
            success: true,
            attempt: {
                _id: attempt._id,
                attemptNumber,
                status: attempt.status,
                testResults: testResults.map(t => ({
                    testNumber: t.testNumber,
                    passed: t.passed,
                    expectedOutput: t.expectedOutput,
                    actualOutput: t.actualOutput,
                    error: t.error,
                })),
                allTestsPassed: attempt.allTestsPassed,
            },
        });
    } catch (error) {
        console.error('Error running code:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to run code' });
    }
});

/**
 * POST /api/oa/session/:sessionId/submit
 * Submit final solution for a question (runs all test cases)
 */
router.post('/session/:sessionId/submit', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { questionId, code, language } = req.body;
        const userId = req.user.userId;

        const session = await OASession.findOne({ _id: sessionId, userId });
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        const question = session.questions.find(q => q.questionId === questionId);
        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found' });
        }

        const languageId = judge0Service.getLanguageId(language);

        // Helper function to convert Map or object to entries
        const getTestCaseEntries = (testcaseData) => {
            if (!testcaseData) return [];
            if (testcaseData instanceof Map) {
                return Array.from(testcaseData.entries());
            }
            const obj = typeof testcaseData.toObject === 'function' ? testcaseData.toObject() : testcaseData;
            return Object.entries(obj);
        };

        // Prepare ALL test cases (visible + hidden + edge)
        const testCases = [];
        let testNumber = 1;

        // Visible tests
        const visibleEntries = getTestCaseEntries(question.visibleTestcases);
        for (const [key, value] of visibleEntries) {
            if (value && (value.input !== undefined || value.output !== undefined)) {
                testCases.push({
                    type: 'visible',
                    number: testNumber++,
                    input: value.input || '',
                    expectedOutput: value.output || '',
                });
            }
        }

        // Hidden tests
        const hiddenEntries = getTestCaseEntries(question.hiddenTestcases);
        for (const [key, value] of hiddenEntries) {
            if (value && (value.input !== undefined || value.output !== undefined)) {
                testCases.push({
                    type: 'hidden',
                    number: testNumber++,
                    input: value.input || '',
                    expectedOutput: value.output || '',
                });
            }
        }

        // Edge tests
        const edgeEntries = getTestCaseEntries(question.edgeTestcases);
        for (const [key, value] of edgeEntries) {
            if (value && (value.input !== undefined || value.output !== undefined)) {
                testCases.push({
                    type: 'edge',
                    number: testNumber++,
                    input: value.input || '',
                    expectedOutput: value.output || '',
                });
            }
        }

        // Run all test cases
        const testResults = await judge0Service.runTestCases(code, languageId, testCases);

        const visiblePassed = testResults.filter(t => t.testType === 'visible' && t.passed).length;
        const hiddenPassed = testResults.filter(t => t.testType === 'hidden' && t.passed).length;
        const edgePassed = testResults.filter(t => t.testType === 'edge' && t.passed).length;
        const totalPassed = testResults.filter(t => t.passed).length;

        // Calculate attempt number
        const attemptCount = await OAAttempt.countDocuments({ sessionId, questionId });
        const attemptNumber = attemptCount + 1;

        // Save attempt
        const attempt = new OAAttempt({
            sessionId,
            userId,
            questionId,
            code,
            language,
            languageId,
            status: testResults.every(t => t.passed) ? 'success' : 'failed',
            testResults,
            visibleTestsPassed: visiblePassed,
            hiddenTestsPassed: hiddenPassed,
            edgeTestsPassed: edgePassed,
            totalTestsPassed: totalPassed,
            totalTests: testResults.length,
            allTestsPassed: testResults.every(t => t.passed),
            attemptNumber,
            isFinalSubmission: true,
        });

        await attempt.save();

        // Update session
        question.attemptCount = attemptNumber;
        question.latestAttemptId = attempt._id;
        await session.save();

        res.json({
            success: true,
            attempt: {
                _id: attempt._id,
                attemptNumber,
                status: attempt.status,
                visibleTestsPassed: visiblePassed,
                hiddenTestsPassed: hiddenPassed,
                edgeTestsPassed: edgePassed,
                totalTestsPassed: totalPassed,
                totalTests: testResults.length,
                allTestsPassed: attempt.allTestsPassed,
            },
        });
    } catch (error) {
        console.error('Error submitting code:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to submit code' });
    }
});

/**
 * GET /api/oa/session/:sessionId/attempts/:questionId
 * Get all attempts for a question
 */
router.get('/session/:sessionId/attempts/:questionId', authenticateToken, async (req, res) => {
    try {
        const { sessionId, questionId } = req.params;
        const userId = req.user.userId;

        const attempts = await OAAttempt.find({ sessionId, userId, questionId })
            .sort({ attemptNumber: 1 })
            .select('-__v');

        res.json({ success: true, attempts });
    } catch (error) {
        console.error('Error fetching attempts:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch attempts' });
    }
});

/**
 * POST /api/oa/session/:sessionId/complete
 * Complete OA session - test all questions against all test cases and generate feedback
 */
router.post('/session/:sessionId/complete', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.user.userId;

        const session = await OASession.findOne({ _id: sessionId, userId });
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        if (session.status === 'completed') {
            return res.status(400).json({ success: false, message: 'Session already completed' });
        }

        // Helper function to convert Map or object to entries
        const getTestCaseEntries = (testcaseData) => {
            if (!testcaseData) return [];
            if (testcaseData instanceof Map) {
                return Array.from(testcaseData.entries());
            }
            const obj = typeof testcaseData.toObject === 'function' ? testcaseData.toObject() : testcaseData;
            return Object.entries(obj);
        };

        // Test all questions against all test cases
        for (const question of session.questions) {
            // Skip if no code was written for this question
            if (!question.latestAttemptId) {
                console.log(`⏭️ Skipping question ${question.questionId} - no attempts`);
                continue;
            }

            const latestAttempt = await OAAttempt.findById(question.latestAttemptId);
            if (!latestAttempt || !latestAttempt.code) {
                console.log(`⏭️ Skipping question ${question.questionId} - no code found`);
                continue;
            }

            console.log(`🧪 Testing question ${question.questionId} with all test cases...`);

            const languageId = judge0Service.getLanguageId(latestAttempt.language);

            // Prepare ALL test cases (visible + hidden + edge)
            const testCases = [];
            let testNumber = 1;

            // Visible tests
            const visibleEntries = getTestCaseEntries(question.visibleTestcases);
            for (const [key, value] of visibleEntries) {
                if (value && (value.input !== undefined || value.output !== undefined)) {
                    testCases.push({
                        type: 'visible',
                        number: testNumber++,
                        input: value.input || '',
                        expectedOutput: value.output || '',
                    });
                }
            }

            // Hidden tests
            const hiddenEntries = getTestCaseEntries(question.hiddenTestcases);
            for (const [key, value] of hiddenEntries) {
                if (value && (value.input !== undefined || value.output !== undefined)) {
                    testCases.push({
                        type: 'hidden',
                        number: testNumber++,
                        input: value.input || '',
                        expectedOutput: value.output || '',
                    });
                }
            }

            // Edge tests
            const edgeEntries = getTestCaseEntries(question.edgeTestcases);
            for (const [key, value] of edgeEntries) {
                if (value && (value.input !== undefined || value.output !== undefined)) {
                    testCases.push({
                        type: 'edge',
                        number: testNumber++,
                        input: value.input || '',
                        expectedOutput: value.output || '',
                    });
                }
            }

            console.log(`   Total test cases: ${testCases.length} (${visibleEntries.length} visible, ${hiddenEntries.length} hidden, ${edgeEntries.length} edge)`);

            // Run all test cases
            const testResults = await judge0Service.runTestCases(latestAttempt.code, languageId, testCases);

            const visiblePassed = testResults.filter(t => t.testType === 'visible' && t.passed).length;
            const hiddenPassed = testResults.filter(t => t.testType === 'hidden' && t.passed).length;
            const edgePassed = testResults.filter(t => t.testType === 'edge' && t.passed).length;
            const totalPassed = testResults.filter(t => t.passed).length;

            console.log(`   Results: ${totalPassed}/${testResults.length} passed (V:${visiblePassed} H:${hiddenPassed} E:${edgePassed})`);

            // Update the latest attempt with full test results
            latestAttempt.testResults = testResults;
            latestAttempt.visibleTestsPassed = visiblePassed;
            latestAttempt.hiddenTestsPassed = hiddenPassed;
            latestAttempt.edgeTestsPassed = edgePassed;
            latestAttempt.totalTestsPassed = totalPassed;
            latestAttempt.totalTests = testResults.length;
            latestAttempt.allTestsPassed = testResults.every(t => t.passed);
            latestAttempt.status = latestAttempt.allTestsPassed ? 'success' : 'failed';
            latestAttempt.isFinalSubmission = true;
            await latestAttempt.save();

            // Score the question
            const { scores, analysis } = await oaScoringService.scoreQuestion(
                question,
                latestAttempt,
                testResults
            );

            question.scores = scores;
            question.analysis = analysis;
        }

        // Calculate overall score
        const { overallScore, normalizedScore } = oaScoringService.calculateOverallScore(session.questions);

        session.overallScore = overallScore;
        session.normalizedScore = normalizedScore;
        session.status = 'completed';
        session.endTime = new Date();
        session.totalDuration = Math.round((session.endTime - session.startTime) / 60000); // minutes

        await session.save();

        console.log(`✅ OA completed - Overall Score: ${normalizedScore}/100`);

        res.json({
            success: true,
            message: 'OA completed successfully',
            overallScore,
            normalizedScore,
        });
    } catch (error) {
        console.error('Error completing OA:', error);
        res.status(500).json({ success: false, message: 'Failed to complete OA' });
    }
});

/**
 * GET /api/oa/feedback/:sessionId
 * Get feedback for completed OA
 */
router.get('/feedback/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.user.userId;

        const session = await OASession.findOne({ _id: sessionId, userId });
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        if (session.status !== 'completed') {
            return res.status(400).json({ success: false, message: 'Session not completed yet' });
        }

        res.json({ success: true, session });
    } catch (error) {
        console.error('Error fetching feedback:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch feedback' });
    }
});

/**
 * POST /api/oa/practice/run-custom
 * Run code with custom input (no test cases, just execute)
 * IMPORTANT: This must come BEFORE /practice/run to avoid route conflicts
 */
router.post('/practice/run-custom', authenticateToken, async (req, res) => {
    try {
        const { code, language, input = '' } = req.body;

        if (!code || !language) {
            return res.status(400).json({ success: false, message: 'Code and language are required' });
        }

        const languageId = judge0Service.getLanguageId(language);
        
        // Execute code with custom input
        const result = await judge0Service.executeCode(code, languageId, input);

        res.json({
            success: true,
            result: {
                status: result.status,
                output: result.stdout || result.output || '',
                stderr: result.stderr || '',
                compileOutput: result.compile_output || '',
                executionTime: result.time ? parseFloat(result.time) * 1000 : null,
                memory: result.memory || null,
            },
        });
    } catch (error) {
        console.error('Error running custom code:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to run code' });
    }
});

/**
 * POST /api/oa/practice/run
 * Run code for practice question
 */
router.post('/practice/run', authenticateToken, async (req, res) => {
    try {
        const { questionId, code, language } = req.body;
        const userId = req.user.userId;

        if (!code || !language) {
            return res.status(400).json({ success: false, message: 'Code and language are required' });
        }

        // Get question
        const question = await OAquestions.findOne({ questionid: questionId });
        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found' });
        }

        const languageId = judge0Service.getLanguageId(language);

        // Prepare ALL test cases for practice
        const testCases = [];
        let testNumber = 1;

        // Helper function to convert Map or object to entries
        const getTestCaseEntries = (testcaseData) => {
            if (!testcaseData) return [];
            if (testcaseData instanceof Map) {
                return Array.from(testcaseData.entries());
            }
            const obj = typeof testcaseData.toObject === 'function' ? testcaseData.toObject() : testcaseData;
            return Object.entries(obj);
        };

        // Visible tests
        const visibleEntries = getTestCaseEntries(question.visible_testcases);
        console.log(`📝 Processing ${visibleEntries.length} visible test cases`);
        for (const [key, value] of visibleEntries) {
            if (value && (value.input !== undefined || value.output !== undefined)) {
                testCases.push({
                    type: 'visible',
                    number: testNumber++,
                    input: value.input || '',
                    expectedOutput: value.output || '',
                });
            }
        }

        // Hidden tests
        const hiddenEntries = getTestCaseEntries(question.hidden_testcases);
        console.log(`📝 Processing ${hiddenEntries.length} hidden test cases`);
        for (const [key, value] of hiddenEntries) {
            if (value && (value.input !== undefined || value.output !== undefined)) {
                testCases.push({
                    type: 'hidden',
                    number: testNumber++,
                    input: value.input || '',
                    expectedOutput: value.output || '',
                });
            }
        }

        // Edge tests
        const edgeEntries = getTestCaseEntries(question.edge_testcases);
        console.log(`📝 Processing ${edgeEntries.length} edge test cases`);
        for (const [key, value] of edgeEntries) {
            if (value && (value.input !== undefined || value.output !== undefined)) {
                testCases.push({
                    type: 'edge',
                    number: testNumber++,
                    input: value.input || '',
                    expectedOutput: value.output || '',
                });
            }
        }

        console.log(`✅ Total test cases prepared: ${testCases.length}`);

        // Run test cases
        const testResults = await judge0Service.runTestCases(code, languageId, testCases);

        const visiblePassed = testResults.filter(t => t.testType === 'visible' && t.passed).length;
        const hiddenPassed = testResults.filter(t => t.testType === 'hidden' && t.passed).length;
        const edgePassed = testResults.filter(t => t.testType === 'edge' && t.passed).length;
        const totalPassed = testResults.filter(t => t.passed).length;
        const allTestsPassed = testResults.every(t => t.passed);

        // Get attempt number
        const attemptCount = await PracticeAttempt.countDocuments({ userId, questionId });
        const attemptNumber = attemptCount + 1;

        // Save practice attempt
        const attempt = new PracticeAttempt({
            userId,
            questionId,
            company: question.company,
            difficulty: question.difficulty,
            role: question.role,
            code,
            language,
            languageId,
            status: allTestsPassed ? 'success' : 'failed',
            testResults,
            visibleTestsPassed: visiblePassed,
            hiddenTestsPassed: hiddenPassed,
            edgeTestsPassed: edgePassed,
            totalTestsPassed: totalPassed,
            totalTests: testResults.length,
            allTestsPassed,
            isSolved: allTestsPassed,
            attemptNumber,
        });

        await attempt.save();

        res.json({
            success: true,
            attempt: {
                _id: attempt._id,
                attemptNumber,
                status: attempt.status,
                testResults,
                visibleTestsPassed: visiblePassed,
                hiddenTestsPassed: hiddenPassed,
                edgeTestsPassed: edgePassed,
                totalTestsPassed: totalPassed,
                totalTests: testResults.length,
                allTestsPassed,
                isSolved: allTestsPassed,
            },
        });
    } catch (error) {
        console.error('Error running practice code:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to run code' });
    }
});

/**
 * POST /api/oa/session/:sessionId/violation
 * Report proctoring violation
 */
router.post('/session/:sessionId/violation', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.user.userId;

        const session = await OASession.findOne({ _id: sessionId, userId });
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        // Increment violation count
        session.violationCount += 1;

        // Terminate session after 3 violations
        if (session.violationCount >= 3) {
            session.isTerminated = true;
            session.status = 'abandoned';
        }

        await session.save();

        res.json({
            success: true,
            violationCount: session.violationCount,
            isTerminated: session.isTerminated,
        });
    } catch (error) {
        console.error('Error reporting violation:', error);
        res.status(500).json({ success: false, message: 'Failed to report violation' });
    }
});

/**
 * GET /api/oa/history
 * Get user's OA history
 */
router.get('/history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { page = 1, limit = 10 } = req.query;

        const skip = (page - 1) * limit;

        const sessions = await OASession.find({ userId })
            .select('-questions.hiddenTestcases -questions.edgeTestcases -questions.optimalSolution')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const total = await OASession.countDocuments({ userId });

        res.json({
            success: true,
            sessions,
            pagination: {
                current: parseInt(page),
                total: Math.ceil(total / limit),
                count: sessions.length,
            },
        });
    } catch (error) {
        console.error('Error fetching OA history:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch OA history' });
    }
});

/**
 * GET /api/oa/languages
 * Get supported languages
 */
router.get('/languages', (req, res) => {
    const languages = judge0Service.getSupportedLanguages();
    res.json({ success: true, languages });
});

export default router;
