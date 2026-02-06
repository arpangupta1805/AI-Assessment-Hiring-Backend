import mongoose from 'mongoose';

/**
 * Evaluation Model
 * Stores complete evaluation results including AI scores and admin decisions
 */
const EvaluationSchema = new mongoose.Schema(
    {
        candidateAssessment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CandidateAssessment',
            required: true,
            unique: true,
        },

        // Section-wise scores
        sections: {
            objective: {
                score: { type: Number, default: 0 },
                maxScore: { type: Number, default: 0 },
                percentage: { type: Number, default: 0 },
                questionsAttempted: { type: Number, default: 0 },
                questionsCorrect: { type: Number, default: 0 },
                totalQuestions: { type: Number, default: 0 },
                details: [{
                    questionId: { type: String },
                    isCorrect: { type: Boolean },
                    points: { type: Number },
                }],
            },
            subjective: {
                score: { type: Number, default: 0 },
                maxScore: { type: Number, default: 0 },
                percentage: { type: Number, default: 0 },
                questionsAttempted: { type: Number, default: 0 },
                totalQuestions: { type: Number, default: 0 },
                details: [{
                    questionId: { type: String },
                    aiScore: { type: Number },
                    maxScore: { type: Number },
                    rubricFeedback: { type: String },
                    keyPointsCovered: [{ type: String }],
                    areasOfImprovement: [{ type: String }],
                }],
            },
            programming: {
                score: { type: Number, default: 0 },
                maxScore: { type: Number, default: 0 },
                percentage: { type: Number, default: 0 },
                questionsAttempted: { type: Number, default: 0 },
                totalQuestions: { type: Number, default: 0 },
                details: [{
                    questionId: { type: String },
                    testCasesPassed: { type: Number },
                    totalTestCases: { type: Number },
                    codeQualityScore: { type: Number },
                    correctnessScore: { type: Number },
                    efficiencyScore: { type: Number },
                    feedback: { type: String },
                }],
            },
        },

        // Overall scores
        totalScore: {
            type: Number,
            default: 0,
        },
        maxTotalScore: {
            type: Number,
            default: 0,
        },
        percentage: {
            type: Number,
            default: 0,
        },

        // Weighted score (based on section weights)
        weightedScore: {
            type: Number,
            default: 0,
        },

        // Skill-wise competency analysis
        skillScores: [{
            skill: { type: String },
            score: { type: Number },
            maxScore: { type: Number },
            percentage: { type: Number },
            competencyLevel: {
                type: String,
                enum: ['beginner', 'intermediate', 'proficient', 'expert'],
            },
            questionsAttempted: { type: Number },
        }],

        // Plagiarism detection
        plagiarism: {
            checked: { type: Boolean, default: false },
            checkedAt: { type: Date },

            // Subjective plagiarism
            subjectivePlagiarismPercent: { type: Number, default: 0 },
            subjectiveMatches: [{
                questionId: { type: String },
                matchPercent: { type: Number },
                source: { type: String },
            }],

            // Code plagiarism
            codePlagiarismPercent: { type: Number, default: 0 },
            codeMatches: [{
                questionId: { type: String },
                matchPercent: { type: Number },
                source: { type: String },
            }],

            isFlagged: { type: Boolean, default: false }, // >80%
            flagReason: { type: String, default: '' },
        },

        // Resume vs Performance correlation
        resumeCorrelation: {
            analyzed: { type: Boolean, default: false },
            claimedSkillsValidated: { type: Number, default: 0 }, // percentage
            performanceMatchesResume: { type: Boolean, default: true },
            discrepancies: [{ type: String }],
            analysis: { type: String, default: '' },
        },

        // AI recommendation (not final)
        aiRecommendation: {
            type: String,
            enum: ['PASS', 'REVIEW', 'FAIL'],
            default: 'REVIEW',
        },
        aiRecommendationReason: {
            type: String,
            default: '',
        },
        aiConfidence: {
            type: Number,
            default: 0,
        },

        // Admin decision (final, human-controlled)
        adminDecision: {
            type: String,
            enum: ['PASS', 'FAIL', 'HOLD', 'REVIEW_PENDING'],
            default: 'REVIEW_PENDING',
        },
        adminDecisionBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        adminDecisionAt: {
            type: Date,
            default: null,
        },
        adminNotes: {
            type: String,
            default: '',
        },

        // Report generation
        reportGenerated: {
            type: Boolean,
            default: false,
        },
        reportUrl: {
            type: String,
            default: '',
        },
        reportGeneratedAt: {
            type: Date,
            default: null,
        },

        // Candidate notification
        resultNotified: {
            type: Boolean,
            default: false,
        },
        resultNotifiedAt: {
            type: Date,
            default: null,
        },

        // Evaluation timing
        evaluationStartedAt: {
            type: Date,
            default: null,
        },
        evaluationCompletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
EvaluationSchema.index({ candidateAssessment: 1 });
EvaluationSchema.index({ aiRecommendation: 1 });
EvaluationSchema.index({ adminDecision: 1 });
EvaluationSchema.index({ 'plagiarism.isFlagged': 1 });

// Calculate weighted score based on section weights
EvaluationSchema.methods.calculateWeightedScore = function (sectionWeights) {
    const { objective, subjective, programming } = this.sections;
    const weights = sectionWeights || { objective: 30, subjective: 30, programming: 40 };

    const objPercent = objective.maxScore > 0 ? (objective.score / objective.maxScore) * 100 : 0;
    const subPercent = subjective.maxScore > 0 ? (subjective.score / subjective.maxScore) * 100 : 0;
    const progPercent = programming.maxScore > 0 ? (programming.score / programming.maxScore) * 100 : 0;

    this.weightedScore = (
        (objPercent * weights.objective / 100) +
        (subPercent * weights.subjective / 100) +
        (progPercent * weights.programming / 100)
    );

    return this.weightedScore;
};

// Generate AI recommendation based on scores
EvaluationSchema.methods.generateRecommendation = function (cutoffScore = 60) {
    // Check plagiarism flag first
    if (this.plagiarism.isFlagged) {
        this.aiRecommendation = 'REVIEW';
        this.aiRecommendationReason = 'Plagiarism detected (>80%). Requires manual review.';
        this.aiConfidence = 90;
        return;
    }

    const score = this.weightedScore || this.percentage;

    if (score >= cutoffScore + 15) {
        this.aiRecommendation = 'PASS';
        this.aiRecommendationReason = `Score ${score.toFixed(1)}% exceeds cutoff by significant margin.`;
        this.aiConfidence = 85;
    } else if (score >= cutoffScore) {
        this.aiRecommendation = 'REVIEW';
        this.aiRecommendationReason = `Score ${score.toFixed(1)}% is near cutoff. Manual review recommended.`;
        this.aiConfidence = 60;
    } else if (score >= cutoffScore - 10) {
        this.aiRecommendation = 'REVIEW';
        this.aiRecommendationReason = `Score ${score.toFixed(1)}% is slightly below cutoff. Consider for potential.`;
        this.aiConfidence = 70;
    } else {
        this.aiRecommendation = 'FAIL';
        this.aiRecommendationReason = `Score ${score.toFixed(1)}% is significantly below cutoff (${cutoffScore}%).`;
        this.aiConfidence = 80;
    }
};

const Evaluation = mongoose.model('Evaluation', EvaluationSchema);

export default Evaluation;
