import mongoose from 'mongoose';

/**
 * Assessment Set Model
 * Stores a complete set of questions for an assessment
 * Multiple sets can be generated per JD for randomization
 */
const AssessmentSetSchema = new mongoose.Schema(
    {
        jd: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'JobDescription',
            required: true,
        },

        setNumber: {
            type: Number,
            required: true,
        },

        // Objective questions (MCQ)
        objectiveQuestions: [{
            questionId: {
                type: String,
                required: true,
            },
            questionText: {
                type: String,
                required: true,
            },
            options: [{
                text: { type: String, required: true },
                isCorrect: { type: Boolean, default: false },
            }],
            skill: {
                type: String,
                default: '',
            },
            difficulty: {
                type: String,
                enum: ['easy', 'medium', 'hard'],
                default: 'medium',
            },
            points: {
                type: Number,
                default: 1,
            },
            explanation: {
                type: String,
                default: '',
            },
        }],

        // Subjective questions (open-ended)
        subjectiveQuestions: [{
            questionId: {
                type: String,
                required: true,
            },
            questionText: {
                type: String,
                required: true,
            },
            expectedAnswer: {
                type: String,
                default: '',
            },
            rubric: {
                type: String,
                default: '',
            },
            skill: {
                type: String,
                default: '',
            },
            difficulty: {
                type: String,
                enum: ['easy', 'medium', 'hard'],
                default: 'medium',
            },
            points: {
                type: Number,
                default: 10,
            },
            maxWords: {
                type: Number,
                default: 500,
            },
        }],

        // Programming questions
        programmingQuestions: [{
            questionId: {
                type: String,
                required: true,
            },
            title: {
                type: String,
                required: true,
            },
            questionText: {
                type: String,
                required: true,
            },
            description: {
                type: String,
                default: '',
            },
            constraints: {
                type: String,
                default: '',
            },
            sampleInput: {
                type: String,
                default: '',
            },
            sampleOutput: {
                type: String,
                default: '',
            },
            // Test cases for execution
            testCases: [{
                input: { type: String, required: true },
                expectedOutput: { type: String, required: true },
                isHidden: { type: Boolean, default: false },
                isSample: { type: Boolean, default: false },
                weight: { type: Number, default: 1 },
            }],
            skill: {
                type: String,
                default: '',
            },
            difficulty: {
                type: String,
                enum: ['easy', 'medium', 'hard'],
                default: 'medium',
            },
            points: {
                type: Number,
                default: 20,
            },
            // Supported languages
            allowedLanguages: {
                type: [String],
                default: ['python', 'javascript', 'java', 'cpp', 'c'],
            },
            timeLimit: {
                type: Number,
                default: 2, // seconds
            },
            memoryLimit: {
                type: Number,
                default: 256, // MB
            },
            // Starter code templates
            starterCode: {
                type: Map,
                of: String,
                default: {},
            },
        }],

        // Metadata
        generationMeta: {
            generatedAt: { type: Date, default: Date.now },
            aiModel: { type: String },
            generationTime: { type: Number }, // ms
        },

        // Total points in this set
        totalPoints: {
            type: Number,
            default: 0,
        },

        isActive: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
AssessmentSetSchema.index({ jd: 1, setNumber: 1 });
AssessmentSetSchema.index({ jd: 1, isActive: 1 });

// Calculate total points before saving
AssessmentSetSchema.pre('save', function (next) {
    let total = 0;

    this.objectiveQuestions.forEach(q => {
        total += q.points || 1;
    });

    this.subjectiveQuestions.forEach(q => {
        total += q.points || 10;
    });

    this.programmingQuestions.forEach(q => {
        total += q.points || 20;
    });

    this.totalPoints = total;
    next();
});

// Get question counts
AssessmentSetSchema.methods.getQuestionCounts = function () {
    return {
        objective: this.objectiveQuestions.length,
        subjective: this.subjectiveQuestions.length,
        programming: this.programmingQuestions.length,
        total: this.objectiveQuestions.length + this.subjectiveQuestions.length + this.programmingQuestions.length,
    };
};

const AssessmentSet = mongoose.model('AssessmentSet', AssessmentSetSchema);

export default AssessmentSet;
