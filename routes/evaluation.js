import express from 'express';
import { body, validationResult } from 'express-validator';
import { callOpenAI } from '../lib/openai.js';
import CandidateAssessment from '../models/CandidateAssessment.js';
import AssessmentAnswer from '../models/AssessmentAnswer.js';
import Evaluation from '../models/Evaluation.js';
import JobDescription from '../models/JobDescription.js';
import { authenticateToken, requireRecruiter } from '../middleware/auth.js';

const router = express.Router();

// OpenAI initialized in lib/openai.js


// ============================================================================
// EVALUATION ROUTES
// ============================================================================

/**
 * POST /api/eval/trigger/:candidateAssessmentId
 * Trigger evaluation for a submitted assessment
 */
router.post('/trigger/:candidateAssessmentId', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('jd')
            .populate('assignedSet');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        // Verify ownership
        if (candidateAssessment.jd.company.toString() !== req.user.company.toString()) {
            return res.status(403).json({
                success: false,
                error: 'Access denied',
            });
        }

        if (candidateAssessment.status !== 'submitted') {
            return res.status(400).json({
                success: false,
                error: 'Assessment must be submitted before evaluation',
            });
        }

        // Check if already evaluated
        let evaluation = await Evaluation.findOne({ candidateAssessment: candidateAssessmentId });
        if (evaluation && evaluation.evaluationCompletedAt) {
            return res.status(400).json({
                success: false,
                error: 'Assessment already evaluated',
                evaluationId: evaluation._id,
            });
        }

        // Update status
        candidateAssessment.status = 'evaluating';
        await candidateAssessment.save();

        // Start evaluation in background
        res.json({
            success: true,
            message: 'Evaluation started',
        });

        // Run evaluation async
        runEvaluation(candidateAssessmentId).catch(err => {
            console.error('❌ Background evaluation error:', err);
        });

    } catch (error) {
        console.error('❌ Trigger evaluation error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to trigger evaluation',
        });
    }
});

/**
 * GET /api/eval/result/:candidateAssessmentId
 * Get evaluation result
 */
router.get('/result/:candidateAssessmentId', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('jd', 'company parsedContent.roleTitle')
            .populate('candidate', 'name email');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        // Verify ownership
        if (candidateAssessment.jd.company.toString() !== req.user.company.toString()) {
            return res.status(403).json({
                success: false,
                error: 'Access denied',
            });
        }

        const evaluation = await Evaluation.findOne({ candidateAssessment: candidateAssessmentId });

        if (!evaluation) {
            return res.status(404).json({
                success: false,
                error: 'Evaluation not found',
            });
        }

        res.json({
            success: true,
            data: {
                candidate: {
                    name: candidateAssessment.candidate.name,
                    email: candidateAssessment.candidate.email,
                },
                roleTitle: candidateAssessment.jd.parsedContent?.roleTitle,
                evaluation,
            },
        });
    } catch (error) {
        console.error('❌ Get evaluation error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get evaluation',
        });
    }
});

/**
 * POST /api/eval/admin-decision/:candidateAssessmentId
 * Set admin decision (PASS/FAIL/HOLD)
 */
router.post('/admin-decision/:candidateAssessmentId', authenticateToken, requireRecruiter, [
    body('decision').isIn(['PASS', 'FAIL', 'HOLD', 'CHEATING']).withMessage('Invalid decision'),
    body('notes').optional().isString(),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { candidateAssessmentId } = req.params;
        const { decision, notes } = req.body;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('jd', 'company');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        // Verify ownership
        if (candidateAssessment.jd.company.toString() !== req.user.company.toString()) {
            return res.status(403).json({
                success: false,
                error: 'Access denied',
            });
        }

        const evaluation = await Evaluation.findOne({ candidateAssessment: candidateAssessmentId });

        if (!evaluation) {
            return res.status(404).json({
                success: false,
                error: 'Evaluation not found. Please run evaluation first.',
            });
        }

        // Update decision
        evaluation.adminDecision = decision;
        evaluation.adminDecisionBy = req.user._id;
        evaluation.adminDecisionAt = new Date();
        evaluation.adminNotes = notes || '';
        await evaluation.save();

        // Update candidate assessment status
        candidateAssessment.status = 'decided';
        await candidateAssessment.save();

        res.json({
            success: true,
            message: 'Decision recorded',
            data: {
                decision: evaluation.adminDecision,
                decidedAt: evaluation.adminDecisionAt,
            },
        });
    } catch (error) {
        console.error('❌ Admin decision error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to record decision',
        });
    }
});

// ============================================================================
// HELPER: Run Full Evaluation
// ============================================================================

// Export for use in other routes (e.g., triggering after submission)
export async function runEvaluation(candidateAssessmentId) {
    console.log(`🚀 Starting evaluation for: ${candidateAssessmentId}`);
    try {
        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('jd')
            .populate('assignedSet');

        if (!candidateAssessment) {
            console.error(`❌ Evaluation aborted: Assessment ${candidateAssessmentId} not found`);
            return;
        }

        // Get all answers
        const answers = await AssessmentAnswer.find({ candidateAssessment: candidateAssessmentId });
        console.log(`📝 Found ${answers.length} answer sections for ${candidateAssessmentId}`);

        // Create or get evaluation
        let evaluation = await Evaluation.findOne({ candidateAssessment: candidateAssessmentId });
        if (!evaluation) {
            evaluation = new Evaluation({
                candidateAssessment: candidateAssessmentId,
                evaluationStartedAt: new Date(),
            });
        }

        const set = candidateAssessment.assignedSet;
        const jd = candidateAssessment.jd;

        if (!jd || !jd.assessmentConfig) {
            console.error(`❌ Evaluation aborted: JD or config missing for ${candidateAssessmentId}`);
            return;
        }

        // ==================== OBJECTIVE SECTION ====================
        const objectiveAnswersDoc = answers.find(a => a.section === 'objective');
        const objectiveAnswers = objectiveAnswersDoc ? objectiveAnswersDoc.objectiveAnswers : [];

        {
            let score = 0, maxScore = 0, correct = 0;
            const details = [];

            // Calculate Max Score based on ALL questions in the Set
            set.objectiveQuestions.forEach(q => {
                maxScore += q.points || 1;
            });

            // Calculate Score based on answers
            objectiveAnswers.forEach(ans => {
                const question = set.objectiveQuestions.find(q => q.questionId === ans.questionId);
                if (question) {
                    // Always verify correctness against the source of truth (Set)
                    let isAnsCorrect = false;
                    if (ans.selectedOptionIndex !== undefined && ans.selectedOptionIndex !== null) {
                        const selectedOpt = question.options[ans.selectedOptionIndex];
                        isAnsCorrect = selectedOpt && selectedOpt.isCorrect;
                    }

                    if (isAnsCorrect) {
                        score += question.points || 1;
                        correct++;
                    }
                    details.push({
                        questionId: ans.questionId,
                        isCorrect: !!isAnsCorrect,
                        points: isAnsCorrect ? question.points || 1 : 0,
                    });
                }
            });

            evaluation.sections.objective = {
                score,
                maxScore,
                percentage: maxScore > 0 ? (score / maxScore) * 100 : 0,
                questionsAttempted: objectiveAnswers.length,
                questionsCorrect: correct,
                totalQuestions: set.objectiveQuestions.length,
                details,
            };
        }

        // ==================== SUBJECTIVE SECTION ====================
        const subjectiveAnswersDoc = answers.find(a => a.section === 'subjective');
        if (subjectiveAnswersDoc && subjectiveAnswersDoc.subjectiveAnswers.length > 0) {
            const details = [];
            let totalScore = 0, totalMaxScore = 0;

            // Calculate Max Score based on ALL questions
            set.subjectiveQuestions.forEach(q => {
                totalMaxScore += q.points || 10;
            });

            for (const ans of subjectiveAnswersDoc.subjectiveAnswers) {
                const question = set.subjectiveQuestions.find(q => q.questionId === ans.questionId);
                if (question && ans.answer) {
                    // AI grading
                    const gradeResult = await gradeSubjectiveAnswer(
                        question.questionText,
                        question.expectedAnswer,
                        question.rubric,
                        ans.answer
                    );

                    const maxPoints = question.points || 10;
                    const aiScore = Math.min(gradeResult.score, maxPoints);

                    details.push({
                        questionId: ans.questionId,
                        aiScore,
                        maxScore: maxPoints,
                        rubricFeedback: gradeResult.feedback,
                        keyPointsCovered: gradeResult.keyPoints || [],
                        areasOfImprovement: gradeResult.improvements || [],
                    });

                    totalScore += aiScore;

                    // Update answer document with AI scores
                    ans.aiScore = aiScore;
                    ans.aiMaxScore = maxPoints;
                    ans.aiFeedback = gradeResult.feedback;
                    ans.rubricEvaluation = gradeResult.rubricFeedback || '';
                }
            }

            await subjectiveAnswersDoc.save();

            evaluation.sections.subjective = {
                score: totalScore,
                maxScore: totalMaxScore,
                percentage: totalMaxScore > 0 ? (totalScore / totalMaxScore) * 100 : 0,
                questionsAttempted: subjectiveAnswersDoc.subjectiveAnswers.filter(a => a.answer).length,
                totalQuestions: set.subjectiveQuestions.length,
                details,
            };
        } else {
            // Handle case where no subjective answers exist but questions exist
            let totalMaxScore = 0;
            set.subjectiveQuestions.forEach(q => {
                totalMaxScore += q.points || 10;
            });
            evaluation.sections.subjective = {
                score: 0,
                maxScore: totalMaxScore,
                percentage: 0,
                questionsAttempted: 0,
                totalQuestions: set.subjectiveQuestions.length,
                details: [],
            };
        }

        // ==================== PROGRAMMING SECTION ====================
        const programmingAnswersDoc = answers.find(a => a.section === 'programming');
        if (programmingAnswersDoc && programmingAnswersDoc.programmingAnswers.length > 0) {
            const details = [];
            let totalScore = 0, totalMaxScore = 0;

            // Calculate Max Score based on ALL questions
            set.programmingQuestions.forEach(q => {
                totalMaxScore += q.points || 20;
            });

            for (const ans of programmingAnswersDoc.programmingAnswers) {
                const question = set.programmingQuestions.find(q => q.questionId === ans.questionId);
                if (question) {
                    const maxPoints = question.points || 20;

                    // Calculate score based on test cases passed
                    const testScore = ans.totalTestCases > 0
                        ? (ans.testCasesPassed / ans.totalTestCases) * maxPoints
                        : 0;

                    details.push({
                        questionId: ans.questionId,
                        testCasesPassed: ans.testCasesPassed,
                        totalTestCases: ans.totalTestCases,
                        codeQualityScore: ans.codeQualityScore || 0,
                        correctnessScore: ans.correctnessScore || testScore,
                        efficiencyScore: ans.efficiencyScore || 0,
                        feedback: ans.allPassed ? 'All test cases passed' : `${ans.testCasesPassed}/${ans.totalTestCases} test cases passed`,
                    });

                    totalScore += testScore;
                }
            }

            evaluation.sections.programming = {
                score: totalScore,
                maxScore: totalMaxScore,
                percentage: totalMaxScore > 0 ? (totalScore / totalMaxScore) * 100 : 0,
                questionsAttempted: programmingAnswersDoc.programmingAnswers.filter(a => a.code).length,
                totalQuestions: set.programmingQuestions.length,
                details,
            };
        } else {
            // Handle case where no programming answers exist but questions exist
            let totalMaxScore = 0;
            set.programmingQuestions.forEach(q => {
                totalMaxScore += q.points || 20;
            });
            evaluation.sections.programming = {
                score: 0,
                maxScore: totalMaxScore,
                percentage: 0,
                questionsAttempted: 0,
                totalQuestions: set.programmingQuestions.length,
                details: [],
            };
        }

        // ==================== OVERALL SCORES ====================
        const objScore = evaluation.sections.objective.score || 0;
        const subScore = evaluation.sections.subjective.score || 0;
        const progScore = evaluation.sections.programming.score || 0;

        const objMax = evaluation.sections.objective.maxScore || 0;
        const subMax = evaluation.sections.subjective.maxScore || 0;
        const progMax = evaluation.sections.programming.maxScore || 0;

        evaluation.totalScore = objScore + subScore + progScore;
        evaluation.maxTotalScore = objMax + subMax + progMax;
        evaluation.percentage = evaluation.maxTotalScore > 0
            ? (evaluation.totalScore / evaluation.maxTotalScore) * 100
            : 0;

        // Calculate weighted score
        evaluation.calculateWeightedScore(jd.assessmentConfig.sections);

        // ==================== SKILL SCORES ====================
        // Aggregate by skill
        const skillMap = new Map();

        // From objective
        evaluation.sections.objective.details?.forEach(d => {
            const q = set.objectiveQuestions.find(q => q.questionId === d.questionId);
            if (q?.skill) {
                if (!skillMap.has(q.skill)) {
                    skillMap.set(q.skill, { score: 0, maxScore: 0, attempted: 0 });
                }
                const s = skillMap.get(q.skill);
                s.score += d.isCorrect ? (q.points || 1) : 0;
                s.maxScore += q.points || 1;
                s.attempted++;
            }
        });

        // Convert to array
        evaluation.skillScores = Array.from(skillMap).map(([skill, data]) => ({
            skill,
            score: data.score,
            maxScore: data.maxScore,
            percentage: data.maxScore > 0 ? (data.score / data.maxScore) * 100 : 0,
            competencyLevel: getCompetencyLevel(data.score / data.maxScore * 100),
            questionsAttempted: data.attempted,
        }));

        // ==================== PLAGIARISM CHECK ====================
        // Simple placeholder - in production, use actual plagiarism service
        evaluation.plagiarism = {
            checked: true,
            checkedAt: new Date(),
            subjectivePlagiarismPercent: 0, // Placeholder
            codePlagiarismPercent: 0, // Placeholder
            isFlagged: false,
            flagReason: '',
        };

        // ==================== RESUME CORRELATION ====================
        evaluation.resumeCorrelation = {
            analyzed: true,
            claimedSkillsValidated: evaluation.percentage,
            performanceMatchesResume: evaluation.percentage >= 50,
            discrepancies: [],
            analysis: `Candidate scored ${evaluation.percentage.toFixed(1)}% overall.`,
        };

        // ==================== AI RECOMMENDATION ====================
        evaluation.generateRecommendation(jd.assessmentConfig.cutoffScore);

        evaluation.evaluationCompletedAt = new Date();
        await evaluation.save();

        // Update candidate assessment
        candidateAssessment.status = 'evaluated';
        await candidateAssessment.save();

        console.log(`✅ Evaluation complete for ${candidateAssessmentId}: ${evaluation.percentage.toFixed(1)}%`);

    } catch (error) {
        console.error(`❌ Evaluation error for ${candidateAssessmentId}:`, error);
    }
}

async function gradeSubjectiveAnswer(question, expectedAnswer, rubric, candidateAnswer) {
    const prompt = `Grade the following subjective answer.

QUESTION:
${question}

EXPECTED ANSWER KEY POINTS:
${expectedAnswer || 'Not provided - use your judgment'}

RUBRIC:
${rubric || 'Grade on accuracy, completeness, and clarity'}

CANDIDATE'S ANSWER:
${candidateAnswer}

Analyze the answer and return JSON:
{
  "score": 0-10,
  "feedback": "Detailed feedback",
  "keyPoints": ["key points covered"],
  "improvements": ["areas for improvement"],
  "rubricFeedback": "How well it meets the rubric"
}

Be fair but strict. Return ONLY valid JSON.`;

    try {
        return await callOpenAI(prompt, process.env.OPENAI_MODEL || 'gpt-4o', true);
    } catch (error) {
        console.error('❌ AI grading error:', error);
        return {
            score: 5,
            feedback: 'Could not grade automatically. Manual review required.',
            keyPoints: [],
            improvements: [],
        };
    }
}

function getCompetencyLevel(percentage) {
    if (percentage >= 90) return 'expert';
    if (percentage >= 70) return 'proficient';
    if (percentage >= 50) return 'intermediate';
    return 'beginner';
}

export default router;
