import mongoose from 'mongoose';

/**
 * Assessment Answer Model
 * Stores candidate's answers for each section
 */
const AssessmentAnswerSchema = new mongoose.Schema(
    {
        candidateAssessment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CandidateAssessment',
            required: true,
        },

        section: {
            type: String,
            enum: ['objective', 'subjective', 'programming'],
            required: true,
        },

        // Objective answers
        objectiveAnswers: [{
            questionId: { type: String, required: true },
            selectedOptionIndex: { type: Number, default: -1 }, // -1 = not answered
            selectedOptionText: { type: String, default: '' },
            isCorrect: { type: Boolean, default: false },
            answeredAt: { type: Date },
            timeSpentSeconds: { type: Number, default: 0 },
        }],

        // Subjective answers
        subjectiveAnswers: [{
            questionId: { type: String, required: true },
            answer: { type: String, default: '' },
            wordCount: { type: Number, default: 0 },
            answeredAt: { type: Date },
            timeSpentSeconds: { type: Number, default: 0 },
            lastSavedAt: { type: Date },

            // AI evaluation (filled during evaluation phase)
            aiScore: { type: Number, default: 0 },
            aiMaxScore: { type: Number, default: 10 },
            aiFeedback: { type: String, default: '' },
            rubricEvaluation: { type: String, default: '' },
        }],

        // Programming answers
        programmingAnswers: [{
            questionId: { type: String, required: true },
            code: { type: String, default: '' },
            language: { type: String, default: 'python' },

            // Test case results (from Judge0)
            testCaseResults: [{
                testCaseIndex: { type: Number },
                input: { type: String },
                expectedOutput: { type: String },
                actualOutput: { type: String },
                passed: { type: Boolean, default: false },
                executionTime: { type: Number }, // ms
                memoryUsed: { type: Number }, // KB
                error: { type: String, default: '' },
                isHidden: { type: Boolean, default: false },
            }],

            // Summary
            testCasesPassed: { type: Number, default: 0 },
            totalTestCases: { type: Number, default: 0 },
            allPassed: { type: Boolean, default: false },

            // Evaluation scores
            codeQualityScore: { type: Number, default: 0 },
            correctnessScore: { type: Number, default: 0 },
            efficiencyScore: { type: Number, default: 0 },

            answeredAt: { type: Date },
            timeSpentSeconds: { type: Number, default: 0 },
            lastSavedAt: { type: Date },
            submittedAt: { type: Date },

            // Run history
            runHistory: [{
                code: { type: String },
                language: { type: String },
                testsPassed: { type: Number },
                totalTests: { type: Number },
                ranAt: { type: Date, default: Date.now },
            }],
        }],

        // Section timing
        sectionStartedAt: {
            type: Date,
            default: null,
        },
        sectionSubmittedAt: {
            type: Date,
            default: null,
        },
        totalTimeSpentSeconds: {
            type: Number,
            default: 0,
        },

        // Section scores (filled during evaluation)
        sectionScore: {
            type: Number,
            default: 0,
        },
        sectionMaxScore: {
            type: Number,
            default: 0,
        },

        // Status
        isSubmitted: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
AssessmentAnswerSchema.index({ candidateAssessment: 1, section: 1 }, { unique: true });
AssessmentAnswerSchema.index({ candidateAssessment: 1 });

// Calculate section score
AssessmentAnswerSchema.methods.calculateScore = function () {
    let score = 0;
    let maxScore = 0;

    if (this.section === 'objective') {
        this.objectiveAnswers.forEach(a => {
            maxScore += 1;
            if (a.isCorrect) score += 1;
        });
    } else if (this.section === 'subjective') {
        this.subjectiveAnswers.forEach(a => {
            maxScore += a.aiMaxScore || 10;
            score += a.aiScore || 0;
        });
    } else if (this.section === 'programming') {
        this.programmingAnswers.forEach(a => {
            // Score based on test cases passed + code quality
            maxScore += 100;
            const testScore = a.totalTestCases > 0
                ? (a.testCasesPassed / a.totalTestCases) * 70
                : 0;
            score += testScore + (a.codeQualityScore || 0) * 0.3;
        });
    }

    this.sectionScore = Math.round(score * 100) / 100;
    this.sectionMaxScore = maxScore;
    return { score: this.sectionScore, maxScore };
};

const AssessmentAnswer = mongoose.model('AssessmentAnswer', AssessmentAnswerSchema);

export default AssessmentAnswer;
