import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * User Model - Updated for Hiring Platform
 * Supports roles: recruiter, candidate
 */
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      select: false, // Don't include password by default in queries
    },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Role-based access
    role: {
      type: String,
      enum: ['recruiter', 'candidate'],
      default: 'candidate',
    },

    // For recruiters - link to company
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
    },

    // Profile
    profileImageUrl: {
      type: String,
      default: '',
    },

    // Webcam-captured profile photo (for candidates during onboarding)
    webcamPhoto: {
      type: String,
      default: '',
    },

    // Email verification
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerifiedAt: {
      type: Date,
      default: null,
    },

    // Consent (for candidates)
    consentAccepted: {
      type: Boolean,
      default: false,
    },
    consentAcceptedAt: {
      type: Date,
      default: null,
    },

    // Phone (optional)
    phone: {
      type: String,
      default: '',
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// Indexes
userSchema.index({ role: 1 });
userSchema.index({ company: 1 });

// Hash password before saving
userSchema.pre('save', async function (next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password for login
userSchema.methods.comparePassword = async function (candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    throw new Error('Password comparison failed');
  }
};

// Check if user is a recruiter
userSchema.methods.isRecruiter = function () {
  return this.role === 'recruiter';
};

// Check if user is a candidate
userSchema.methods.isCandidate = function () {
  return this.role === 'candidate';
};

const User = mongoose.model('User', userSchema);

export default User;
