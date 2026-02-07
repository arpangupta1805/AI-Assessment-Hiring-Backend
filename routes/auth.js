import express from 'express';
import { body, validationResult } from 'express-validator';
import User from '../models/User.js';
import Company from '../models/Company.js';
import OTP from '../models/OTP.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// ============================================================================
// VALIDATION MIDDLEWARE
// ============================================================================

const validateSignup = [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('role').isIn(['recruiter', 'candidate']).withMessage('Role must be recruiter or candidate'),
];

const validateLogin = [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
  body('password').notEmpty().withMessage('Password is required'),
];

const validateOTP = [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
];

// ============================================================================
// OTP ENDPOINTS
// ============================================================================

/**
 * POST /api/auth/send-otp
 * Send OTP to email for verification
 */
router.post('/send-otp', [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
  body('purpose').optional().isIn(['email_verification', 'password_reset', 'assessment_access'])
    .withMessage('Invalid purpose'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, purpose = 'email_verification' } = req.body;

    // Generate OTP
    const { otp, expiresAt } = await OTP.createOTP(email, purpose);

    // TODO: Send email with OTP using email service
    // For now, log it (in production, use actual email service)
    console.log(`📧 OTP for ${email}: ${otp} (expires: ${expiresAt})`);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      data: {
        email,
        expiresAt,
        // In development, include OTP for testing
        ...(process.env.NODE_ENV === 'development' && { otp }),
      },
    });
  } catch (error) {
    console.error('❌ Send OTP error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send OTP',
      message: error.message,
    });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verify OTP
 */
router.post('/verify-otp', validateOTP, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, otp, purpose = 'email_verification' } = req.body;

    const result = await OTP.verifyOTP(email, otp, purpose);

    if (!result.valid) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    // If this is email verification and user exists, mark email as verified
    if (purpose === 'email_verification') {
      const user = await User.findOne({ email });
      if (user) {
        user.isEmailVerified = true;
        user.emailVerifiedAt = new Date();
        await user.save();
      }
    }

    res.json({
      success: true,
      message: 'OTP verified successfully',
    });
  } catch (error) {
    console.error('❌ Verify OTP error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify OTP',
      message: error.message,
    });
  }
});

// ============================================================================
// SIGNUP ENDPOINTS
// ============================================================================

/**
 * POST /api/auth/signup
 * Register new user (recruiter or candidate)
 */
router.post('/signup', validateSignup, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, username, name, role, companyName, companyEmail } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: existingUser.email === email
          ? 'Email already registered'
          : 'Username already taken',
      });
    }

    let company = null;

    // For recruiters, create or link company
    if (role === 'recruiter') {
      if (companyName) {
        // Check if company exists by email
        company = await Company.findOne({ email: companyEmail || email });

        if (!company) {
          // Create new company
          company = await Company.create({
            name: companyName,
            email: companyEmail || email,
          });
          console.log('✅ Created new company:', company.name);
        }
      }
    }

    // Create new user
    const user = await User.create({
      email,
      password,
      username,
      name,
      role,
      company: company?._id || null,
      isEmailVerified: false,
      isActive: true,
    });

    // Generate token
    const token = generateToken(user._id, false);

    console.log(`✅ New ${role} registered:`, user.email);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        token,
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          name: user.name,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
          company: company ? {
            id: company._id,
            name: company.name,
          } : null,
        },
      },
    });
  } catch (error) {
    console.error('❌ Signup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register user',
      message: error.message,
    });
  }
});

/**
 * POST /api/auth/signup/recruiter
 * Quick signup for recruiters with company details
 */
router.post('/signup/recruiter', [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('companyName').trim().notEmpty().withMessage('Company name is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, name, companyName, companyEmail } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Email already registered',
      });
    }

    // Create or find company
    let company = await Company.findOne({ email: companyEmail || email });
    if (!company) {
      company = await Company.create({
        name: companyName,
        email: companyEmail || email,
      });
    }

    // Generate username from email
    const username = email.split('@')[0] + '_' + Date.now().toString(36);

    // Create recruiter
    const user = await User.create({
      email,
      password,
      username,
      name,
      role: 'recruiter',
      company: company._id,
      isEmailVerified: false,
    });

    const token = generateToken(user._id, false);

    res.status(201).json({
      success: true,
      message: 'Recruiter registered successfully',
      data: {
        token,
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          name: user.name,
          role: 'recruiter',
          company: {
            id: company._id,
            name: company.name,
          },
        },
      },
    });
  } catch (error) {
    console.error('❌ Recruiter signup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register recruiter',
      message: error.message,
    });
  }
});

// ============================================================================
// LOGIN ENDPOINTS
// ============================================================================

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login', validateLogin, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, rememberMe } = req.body;

    // Find user by email and include password
    const user = await User.findOne({ email }).select('+password').populate('company');

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'Account is inactive',
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    // Generate token
    const token = generateToken(user._id, rememberMe);

    console.log(`✅ ${user.role} logged in:`, user.email);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          name: user.name,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
          profileImageUrl: user.profileImageUrl,
          company: user.company ? {
            id: user.company._id,
            name: user.company.name,
          } : null,
        },
      },
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to login',
      message: error.message,
    });
  }
});

// ============================================================================
// TOKEN VERIFICATION
// ============================================================================

/**
 * POST /api/auth/verify
 * Verify token and get user info
 */
router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided',
      });
    }

    const jwt = (await import('jsonwebtoken')).default;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.userId).select('-password').populate('company');

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token or inactive user',
      });
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          name: user.name,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
          profileImageUrl: user.profileImageUrl,
          company: user.company ? {
            id: user.company._id,
            name: user.company.name,
          } : null,
        },
      },
    });
  } catch (error) {
    console.error('❌ Token verification error:', error);
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password').populate('company');

    res.json({
      success: true,
      data: {
        id: user._id,
        email: user.email,
        username: user.username,
        name: user.name,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        profileImageUrl: user.profileImageUrl,
        webcamPhoto: user.webcamPhoto,
        consentAccepted: user.consentAccepted,
        company: user.company ? {
          id: user.company._id,
          name: user.company.name,
        } : null,
      },
    });
  } catch (error) {
    console.error('❌ Get me error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user info',
    });
  }
});

// ============================================================================
// PROFILE MANAGEMENT
// ============================================================================

/**
 * PUT /api/auth/profile
 * Update user profile
 */
router.put('/profile', authenticateToken, [
  body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
  body('username').optional().trim().isLength({ min: 3, max: 20 }).withMessage('Username must be 3-20 characters'),
  body('companyName').optional().trim().notEmpty().withMessage('Company name cannot be empty'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, username, companyName } = req.body;
    const user = await User.findById(req.user._id).populate('company');

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Update user fields
    if (name) user.name = name;

    // Candidates can update username
    if (username && user.role === 'candidate') {
      // Check if username is taken
      const existingUser = await User.findOne({ username, _id: { $ne: user._id } });
      if (existingUser) {
        return res.status(400).json({ success: false, error: 'Username already taken' });
      }
      user.username = username;
    }

    await user.save();

    // Update company name for recruiters
    if (companyName && user.role === 'recruiter' && user.company) {
      await Company.findByIdAndUpdate(user.company._id, { name: companyName });
    }

    const updatedUser = await User.findById(user._id).select('-password').populate('company');

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        id: updatedUser._id,
        email: updatedUser.email,
        username: updatedUser.username,
        name: updatedUser.name,
        role: updatedUser.role,
        company: updatedUser.company ? {
          id: updatedUser.company._id,
          name: updatedUser.company.name,
        } : null,
      },
    });
  } catch (error) {
    console.error('❌ Profile update error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile',
      message: error.message,
    });
  }
});

/**
 * POST /api/auth/change-password
 * Change user password
 */
router.post('/change-password', authenticateToken, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    // Get user with password
    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    console.log(`✅ Password changed for user: ${user.email}`);

    res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    console.error('❌ Password change error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password',
      message: error.message,
    });
  }
});

export default router;
