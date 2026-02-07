import mongoose from 'mongoose';

/**
 * Job Description Model - Complete overhaul for Hiring Platform
 * Stores parsed JD, assessment configuration, and recruiter controls
 */
const JobDescriptionSchema = new mongoose.Schema(
  {
    // Ownership
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    recruiter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Raw input
    rawText: {
      type: String,
      default: '',
    },
    rawFileUrl: {
      type: String,
      default: '',
    },
    rawFileName: {
      type: String,
      default: '',
    },

    // Parsed & extracted content (populated by AI)
    parsedContent: {
      refinedJD: {
        type: String,
        default: '',
      },
      companyName: {
        type: String,
        default: '',
      },
      aboutCompany: {
        type: String,
        default: '',
      },
      roleTitle: {
        type: String,
        default: '',
      },
      roleResponsibilities: {
        type: [String],
        default: [],
      },
      experienceLevel: {
        type: String,
        enum: ['fresher', 'junior', 'mid', 'senior', 'lead', 'executive'],
        default: 'mid',
      },
      yearsOfExperience: {
        min: { type: Number, default: 0 },
        max: { type: Number, default: 0 },
      },

      // Technical skills with weights and difficulty
      technicalSkills: [{
        name: { type: String, required: true },
        category: { type: String, default: 'Other' },
        weight: { type: Number, min: 1, max: 10, default: 5 },
        difficulty: {
          type: String,
          enum: ['basic', 'intermediate', 'advanced'],
          default: 'intermediate'
        },
        isPrimary: { type: Boolean, default: false },
      }],

      // Soft skills
      softSkills: [{
        name: { type: String, required: true },
        weight: { type: Number, min: 1, max: 10, default: 5 },
      }],

      // Tools and technologies mentioned
      toolsAndTechnologies: {
        type: [String],
        default: [],
      },

      // Qualifications
      qualifications: {
        type: [String],
        default: [],
      },
    },

    // Evaluation rubrics (AI generated, recruiter editable)
    evaluationRubrics: {
      type: String,
      default: '',
    },

    // Assessment configuration (recruiter editable)
    assessmentConfig: {
      // Scoring
      cutoffScore: {
        type: Number,
        default: 60,
        min: 0,
        max: 100,
      },

      // Resume matching threshold
      resumeMatchThreshold: {
        type: Number,
        default: 70,
        min: 0,
        max: 100,
      },

      // Difficulty distribution
      difficultyDistribution: {
        easy: { type: Number, default: 20 },
        medium: { type: Number, default: 50 },
        hard: { type: Number, default: 30 },
      },

      // Section breakdown
      sections: {
        objective: {
          questionCount: { type: Number, default: 10 },
          timeMinutes: { type: Number, default: 15 },
          weight: { type: Number, default: 30 },
          enabled: { type: Boolean, default: true },
        },
        subjective: {
          questionCount: { type: Number, default: 5 },
          timeMinutes: { type: Number, default: 20 },
          weight: { type: Number, default: 30 },
          enabled: { type: Boolean, default: true },
        },
        programming: {
          questionCount: { type: Number, default: 2 },
          timeMinutes: { type: Number, default: 45 },
          weight: { type: Number, default: 40 },
          enabled: { type: Boolean, default: true },
        },
      },

      // Total time calculated from sections
      totalTimeMinutes: {
        type: Number,
        default: 80,
      },

      // Question sets
      numberOfSets: {
        type: Number,
        default: 3,
        min: 1,
        max: 10,
      },

      // Timing window
      startTime: {
        type: Date,
        default: null,
      },
      endTime: {
        type: Date,
        default: null,
      },

      // Lock status
      isLocked: {
        type: Boolean,
        default: false,
      },
      lockedAt: {
        type: Date,
        default: null,
      },

      // Generated assessment link
      assessmentLink: {
        type: String,
        unique: true,
        sparse: true, // Allow null for drafts
      },
      linkGeneratedAt: {
        type: Date,
        default: null,
      },

      // Attempt limits
      maxAttempts: {
        type: Number,
        default: 1,
      },

      // Instructions for candidates
      instructions: {
        type: String,
        default: '',
      },
    },

    // Generated question sets (references)
    assessmentSets: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssessmentSet',
    }],

    // Status workflow
    status: {
      type: String,
      enum: ['draft', 'parsing', 'parsed', 'generating_sets', 'ready', 'active', 'expired', 'closed'],
      default: 'draft',
    },

    // Parsing metadata
    parsingMeta: {
      parsedAt: { type: Date },
      parseErrors: [{ type: String }],
      aiModel: { type: String },
    },

    // Statistics
    stats: {
      totalCandidates: { type: Number, default: 0 },
      completedAssessments: { type: Number, default: 0 },
      averageScore: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
JobDescriptionSchema.index({ company: 1, createdAt: -1 });
JobDescriptionSchema.index({ recruiter: 1, createdAt: -1 });
// Redundant with unique: true in field definition
// JobDescriptionSchema.index({ assessmentLink: 1 });
JobDescriptionSchema.index({ status: 1 });
JobDescriptionSchema.index({ 'assessmentConfig.startTime': 1, 'assessmentConfig.endTime': 1 });

// Generate unique assessment link
JobDescriptionSchema.statics.generateAssessmentLink = function () {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Check if assessment is currently active
JobDescriptionSchema.methods.isActiveNow = function () {
  if (this.status !== 'active') return false;
  const now = new Date();
  const { startTime, endTime } = this.assessmentConfig;
  if (startTime && now < startTime) return false;
  if (endTime && now > endTime) return false;
  return true;
};

// Calculate total time from sections
JobDescriptionSchema.methods.calculateTotalTime = function () {
  const { objective, subjective, programming } = this.assessmentConfig.sections;
  let total = 0;
  if (objective.enabled) total += objective.timeMinutes;
  if (subjective.enabled) total += subjective.timeMinutes;
  if (programming.enabled) total += programming.timeMinutes;
  return total;
};

const JobDescription = mongoose.model('JobDescription', JobDescriptionSchema);

export default JobDescription;
