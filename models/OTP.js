import mongoose from 'mongoose';

/**
 * OTP Model
 * Stores OTPs for email verification
 */
const OTPSchema = new mongoose.Schema(
    {
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
        },
        otp: {
            type: String,
            required: true,
        },
        purpose: {
            type: String,
            enum: ['email_verification', 'password_reset', 'assessment_access'],
            default: 'email_verification',
        },
        expiresAt: {
            type: Date,
            required: true,
        },
        verified: {
            type: Boolean,
            default: false,
        },
        attempts: {
            type: Number,
            default: 0,
        },
        maxAttempts: {
            type: Number,
            default: 5,
        },
    },
    {
        timestamps: true,
    }
);

// Auto-expire documents after expiresAt
OTPSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OTPSchema.index({ email: 1, purpose: 1 });

/**
 * Generate a 6-digit OTP
 */
OTPSchema.statics.generateOTP = function () {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Create OTP with expiry (default 10 minutes)
 */
OTPSchema.statics.createOTP = async function (email, purpose = 'email_verification', expiryMinutes = 10) {
    // Invalidate any existing OTPs for this email and purpose
    await this.deleteMany({ email: email.toLowerCase(), purpose });

    const otp = this.generateOTP();
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    const otpDoc = await this.create({
        email: email.toLowerCase(),
        otp,
        purpose,
        expiresAt,
    });

    return { otp, expiresAt, id: otpDoc._id };
};

/**
 * Verify OTP
 */
OTPSchema.statics.verifyOTP = async function (email, otp, purpose = 'email_verification') {
    const otpDoc = await this.findOne({
        email: email.toLowerCase(),
        purpose,
        verified: false,
    });

    if (!otpDoc) {
        return { valid: false, error: 'OTP not found or already used' };
    }

    if (new Date() > otpDoc.expiresAt) {
        return { valid: false, error: 'OTP has expired' };
    }

    if (otpDoc.attempts >= otpDoc.maxAttempts) {
        return { valid: false, error: 'Maximum attempts exceeded' };
    }

    if (otpDoc.otp !== otp) {
        otpDoc.attempts += 1;
        await otpDoc.save();
        return { valid: false, error: 'Invalid OTP' };
    }

    // Mark as verified
    otpDoc.verified = true;
    await otpDoc.save();

    return { valid: true };
};

const OTP = mongoose.model('OTP', OTPSchema);

export default OTP;
