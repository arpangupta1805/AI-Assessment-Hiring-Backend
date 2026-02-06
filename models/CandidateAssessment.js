import mongoose from 'mongoose';

/**
 * Candidate Assessment Model
 * Tracks a candidate's complete assessment journey from invite to decision
 */
const CandidateAssessmentSchema = new mongoose.Schema(
    {
        // Links
        candidate: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        jd: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'JobDescription',
            required: true,
        },
        assessmentLink: {
            type: String,
            required: true,
        },

        // Onboarding status
        onboarding: {
            emailVerified: { type: Boolean, default: false },
            emailVerifiedAt: { type: Date },
            profilePhotoCaptured: { type: Boolean, default: false },
            profilePhotoUrl: { type: String, default: '' },
            consentAccepted: { type: Boolean, default: false },
            consentAcceptedAt: { type: Date },
            onboardingCompletedAt: { type: Date },
        },

        // Resume submission & matching
        resume: {
            fileUrl: { type: String, default: '' },
            fileName: { type: String, default: '' },
            parsedText: { type: String, default: '' },

            // AI matching results
            matchScore: { type: Number, default: 0 }, // 0-100
            matchDetails: {
                skillMatches: [{
                    skill: { type: String },
                    matched: { type: Boolean },
                    confidence: { type: Number },
                }],
                experienceMatch: { type: Boolean, default: false },
                qualificationMatch: { type: Boolean, default: false },
                overallAnalysis: { type: String, default: '' },
            },

            isFake: { type: Boolean, default: false },
            fakeReasons: [{ type: String }],
            passedThreshold: { type: Boolean, default: false },
            analyzedAt: { type: Date },
        },

        // Assigned question set
        assignedSet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AssessmentSet',
            default: null,
        },
        assignedSetNumber: {
            type: Number,
            default: null,
        },
        assignedAt: {
            type: Date,
            default: null,
        },

        // Session management
        sessionToken: {
            type: String,
            default: null,
        },
        sessionCreatedAt: {
            type: Date,
            default: null,
        },
        lastHeartbeat: {
            type: Date,
            default: null,
        },

        // Timing
        startedAt: {
            type: Date,
            default: null,
        },
        submittedAt: {
            type: Date,
            default: null,
        },
        timeSpentSeconds: {
            type: Number,
            default: 0,
        },

        // Section progress
        sectionProgress: {
            objective: {
                started: { type: Boolean, default: false },
                startedAt: { type: Date },
                completed: { type: Boolean, default: false },
                completedAt: { type: Date },
                questionsAnswered: { type: Number, default: 0 },
            },
            subjective: {
                started: { type: Boolean, default: false },
                startedAt: { type: Date },
                completed: { type: Boolean, default: false },
                completedAt: { type: Date },
                questionsAnswered: { type: Number, default: 0 },
            },
            programming: {
                started: { type: Boolean, default: false },
                startedAt: { type: Date },
                completed: { type: Boolean, default: false },
                completedAt: { type: Date },
                questionsAnswered: { type: Number, default: 0 },
            },
        },

        // Current section being attempted
        currentSection: {
            type: String,
            enum: ['objective', 'subjective', 'programming', null],
            default: null,
        },

        // Status workflow
        status: {
            type: String,
            enum: [
                'invited',           // Link shared
                'onboarding',        // Started onboarding
                'resume_review',     // Resume uploaded, awaiting check
                'resume_rejected',   // Resume didn't meet threshold
                'ready',             // Onboarding complete, ready to start
                'in_progress',       // Assessment started
                'submitted',         // Assessment submitted
                'evaluating',        // Evaluation in progress
                'evaluated',         // Evaluation complete
                'decided',           // Admin made final decision
            ],
            default: 'invited',
        },

        // Proctoring integrity status
        integrityStatus: {
            type: String,
            enum: ['CLEAR', 'FLAGGED_UNDER_REVIEW'],
            default: 'CLEAR',
        },

        // Proctoring event counts (for quick reference)
        proctoringStats: {
            totalEvents: { type: Number, default: 0 },
            highSeverityEvents: { type: Number, default: 0 },
            tabSwitches: { type: Number, default: 0 },
            faceDetectionIssues: { type: Number, default: 0 },
        },

        // Attempt number (if retakes allowed)
        attemptNumber: {
            type: Number,
            default: 1,
        },

        // IP tracking
        ipAddress: {
            type: String,
            default: '',
        },
        userAgent: {
            type: String,
            default: '',
        },

        // Communication log (emails sent)
        communicationLog: [{
            type: { type: String }, // email type (result_pass, result_fail, etc.)
            sentAt: { type: Date },
            sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            subject: { type: String },
        }],
    },
    {
        timestamps: true,
    }
);

// Indexes
CandidateAssessmentSchema.index({ candidate: 1, jd: 1 });
CandidateAssessmentSchema.index({ assessmentLink: 1 });
CandidateAssessmentSchema.index({ jd: 1, status: 1 });
CandidateAssessmentSchema.index({ jd: 1, createdAt: -1 });
CandidateAssessmentSchema.index({ sessionToken: 1 });

// Check if onboarding is complete
CandidateAssessmentSchema.methods.isOnboardingComplete = function () {
    return (
        this.onboarding.emailVerified &&
        this.onboarding.profilePhotoCaptured &&
        this.onboarding.consentAccepted &&
        this.resume.passedThreshold
    );
};

// Generate session token
CandidateAssessmentSchema.statics.generateSessionToken = function () {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'sess_';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

const CandidateAssessment = mongoose.model('CandidateAssessment', CandidateAssessmentSchema);

export default CandidateAssessment;
