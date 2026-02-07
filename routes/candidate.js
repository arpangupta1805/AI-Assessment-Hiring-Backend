import express from 'express';
import { body, validationResult } from 'express-validator';
import { callOpenAI } from '../lib/openai.js';
import JobDescription from '../models/JobDescription.js';
import CandidateAssessment from '../models/CandidateAssessment.js';
import AssessmentSet from '../models/AssessmentSet.js';
import User from '../models/User.js';
import OTP from '../models/OTP.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { uploadResume, saveBase64Image, extractResumeText } from '../services/uploadService.js';
import emailService from '../services/emailService.js';

const router = express.Router();

// OpenAI initialized in lib/openai.js


// ============================================================================
// PUBLIC ROUTES (Assessment Link Access)
// ============================================================================

/**
 * GET /api/candidate/assessment/:link
 * Get assessment info by link (public, before auth)
 */
router.get('/assessment/:link', async (req, res) => {
    try {
        const { link } = req.params;

        const jd = await JobDescription.findOne({
            'assessmentConfig.assessmentLink': link,
        }).populate('company', 'name logo');

        if (!jd) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        // Check if assessment is active
        const now = new Date();
        const { startTime, endTime } = jd.assessmentConfig;

        let status = 'active';
        if (startTime && now < startTime) {
            status = 'not_started';
        } else if (endTime && now > endTime) {
            status = 'expired';
        }

        res.json({
            success: true,
            data: {
                companyName: jd.company?.name || 'Company',
                companyLogo: jd.company?.logo || '',
                roleTitle: jd.parsedContent?.roleTitle || 'Position',
                aboutCompany: jd.parsedContent?.aboutCompany || '',
                instructions: jd.assessmentConfig.instructions || '',
                startTime: jd.assessmentConfig.startTime,
                endTime: jd.assessmentConfig.endTime,
                totalTimeMinutes: jd.assessmentConfig.totalTimeMinutes,
                sections: {
                    objective: jd.assessmentConfig.sections.objective.enabled,
                    subjective: jd.assessmentConfig.sections.subjective.enabled,
                    programming: jd.assessmentConfig.sections.programming.enabled,
                },
                status,
            },
        });
    } catch (error) {
        console.error('❌ Get assessment info error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get assessment info',
        });
    }
});

/**
 * POST /api/candidate/register/:link
 * Register as candidate for an assessment
 */
router.post('/register/:link', [
    body('email').isEmail().normalizeEmail().withMessage('Invalid email'),
    body('name').trim().notEmpty().withMessage('Name is required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { link } = req.params;
        const { email, name, phone } = req.body;

        // Find the JD
        const jd = await JobDescription.findOne({
            'assessmentConfig.assessmentLink': link,
        });

        if (!jd) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        // Check if assessment is within time bounds
        const now = new Date();
        if (jd.assessmentConfig.startTime && now < jd.assessmentConfig.startTime) {
            return res.status(400).json({
                success: false,
                error: 'Assessment has not started yet',
            });
        }
        if (jd.assessmentConfig.endTime && now > jd.assessmentConfig.endTime) {
            return res.status(400).json({
                success: false,
                error: 'Assessment has expired',
            });
        }

        // Check if user already exists or create new
        let user = await User.findOne({ email });

        if (!user) {
            // Create candidate user
            const username = email.split('@')[0] + '_' + Date.now().toString(36);
            const password = Math.random().toString(36).slice(-8) + 'A1!'; // Temp password

            user = await User.create({
                email,
                password,
                username,
                name,
                phone: phone || '',
                role: 'candidate',
                isEmailVerified: false,
            });
        }

        // Check if already registered for this assessment
        let candidateAssessment = await CandidateAssessment.findOne({
            candidate: user._id,
            jd: jd._id,
        });


        // Create new candidate assessment
        candidateAssessment = await CandidateAssessment.create({
            candidate: user._id,
            jd: jd._id,
            assessmentLink: link,
            status: 'onboarding',
        });

        // Increment JD candidate count
        jd.stats.totalCandidates += 1;
        await jd.save();

        // Send OTP for email verification
        const { otp, expiresAt } = await OTP.createOTP(email, 'email_verification');

        // Actually send the email
        try {
            await emailService.sendOTP(email, otp);
            console.log(`📧 OTP sent to ${email}`);
        } catch (emailError) {
            console.error('❌ Failed to send OTP email:', emailError);
            // In dev mode we can still proceed as OTP is logged
            if (process.env.NODE_ENV !== 'development') {
                return res.status(500).json({
                    success: false,
                    error: 'Failed to send verification email',
                });
            }
        }

        console.log(`📧 OTP for ${email}: ${otp}`);

        res.status(201).json({
            success: true,
            message: 'Registration successful. Please verify your email.',
            data: {
                candidateAssessmentId: candidateAssessment._id,
                email,
                status: candidateAssessment.status,
                onboarding: candidateAssessment.onboarding,
                // Dev only
                ...(process.env.NODE_ENV === 'development' && { otp }),
            },
        });
    } catch (error) {
        console.error('❌ Register candidate error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to register for assessment',
        });
    }
});

/**
 * POST /api/candidate/verify-email/:candidateAssessmentId
 * Verify email with OTP
 */
router.post('/verify-email/:candidateAssessmentId', [
    body('otp').isLength({ min: 6, max: 6 }).withMessage('Invalid OTP'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { candidateAssessmentId } = req.params;
        const { otp } = req.body;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('candidate', 'email');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        // Verify OTP
        const result = await OTP.verifyOTP(
            candidateAssessment.candidate.email,
            otp,
            'email_verification'
        );

        if (!result.valid) {
            return res.status(400).json({
                success: false,
                error: result.error,
            });
        }

        // Update candidate assessment
        candidateAssessment.onboarding.emailVerified = true;
        candidateAssessment.onboarding.emailVerifiedAt = new Date();
        await candidateAssessment.save();

        // Update user
        await User.findByIdAndUpdate(candidateAssessment.candidate._id, {
            isEmailVerified: true,
            emailVerifiedAt: new Date(),
        });

        res.json({
            success: true,
            message: 'Email verified successfully',
            data: {
                onboarding: candidateAssessment.onboarding,
            },
        });
    } catch (error) {
        console.error('❌ Verify email error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to verify email',
        });
    }
});

/**
 * POST /api/candidate/capture-photo/:candidateAssessmentId
 * Save webcam captured profile photo
 * Accepts base64 image data, saves to /uploads/images/
 */
router.post('/capture-photo/:candidateAssessmentId', [
    body('photoData').notEmpty().withMessage('Photo data is required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { candidateAssessmentId } = req.params;
        const { photoData } = req.body; // Base64 data

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId);

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        // Save base64 image to file
        let photoUrl = photoData;
        if (photoData.startsWith('data:image/')) {
            // It's base64, save to file
            photoUrl = await saveBase64Image(photoData, `candidate_${candidateAssessmentId}`);
        }

        // Save photo URL
        candidateAssessment.onboarding.profilePhotoCaptured = true;
        candidateAssessment.onboarding.profilePhotoUrl = photoUrl;
        await candidateAssessment.save();

        // Also update user
        await User.findByIdAndUpdate(candidateAssessment.candidate, {
            webcamPhoto: photoUrl,
        });

        res.json({
            success: true,
            message: 'Photo captured successfully',
            data: {
                onboarding: candidateAssessment.onboarding,
                photoUrl,
            },
        });
    } catch (error) {
        console.error('❌ Capture photo error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to capture photo',
        });
    }
});

/**
 * POST /api/candidate/accept-consent/:candidateAssessmentId
 * Accept proctoring and AI evaluation consent
 */
router.post('/accept-consent/:candidateAssessmentId', async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId);

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        candidateAssessment.onboarding.consentAccepted = true;
        candidateAssessment.onboarding.consentAcceptedAt = new Date();
        await candidateAssessment.save();

        // Update user
        await User.findByIdAndUpdate(candidateAssessment.candidate, {
            consentAccepted: true,
            consentAcceptedAt: new Date(),
        });

        res.json({
            success: true,
            message: 'Consent accepted',
            data: {
                onboarding: candidateAssessment.onboarding,
            },
        });
    } catch (error) {
        console.error('❌ Accept consent error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to accept consent',
        });
    }
});

/**
 * POST /api/candidate/upload-resume/:candidateAssessmentId
 * Upload resume file and check JD match
 * Saves file to /uploads/resumes/
 */
router.post('/upload-resume/:candidateAssessmentId',
    uploadResume.single('resume'), // Multer middleware for file upload
    async (req, res) => {
        try {
            const { candidateAssessmentId } = req.params;
            const { resumeText } = req.body; // Optional parsed text from frontend

            const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
                .populate('jd');

            if (!candidateAssessment) {
                return res.status(404).json({
                    success: false,
                    error: 'Assessment not found',
                });
            }

            // Check onboarding steps
            if (!candidateAssessment.onboarding.emailVerified) {
                return res.status(400).json({
                    success: false,
                    error: 'Please verify your email first',
                });
            }

            // Check if file was uploaded
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error: 'Resume file is required',
                });
            }

            // Save resume info
            candidateAssessment.resume.fileUrl = `/uploads/resumes/${req.file.filename}`;
            candidateAssessment.resume.fileName = req.file.originalname;

            // Extract text from the uploaded file
            const extractedText = await extractResumeText(candidateAssessment.resume.fileUrl);

            if (!extractedText) {
                return res.status(400).json({
                    success: false,
                    error: 'Could not extract text from your resume. Please ensure it is a valid PDF or Word document.'
                });
            }

            candidateAssessment.resume.parsedText = extractedText;
            candidateAssessment.status = 'resume_review';
            await candidateAssessment.save();

            // Wait for resume matching (Sync Flow)
            const updatedAssessment = await matchResumeWithJD(candidateAssessmentId);

            res.json({
                success: true,
                message: 'Resume analyzed successfully',
                data: {
                    status: updatedAssessment?.status || 'resume_review',
                    resume: updatedAssessment?.resume,
                },
            });
        } catch (error) {
            console.error('❌ Upload resume error:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to upload resume',
            });
        }
    });

/**
 * GET /api/candidate/resume-status/:candidateAssessmentId
 * Get resume match status
 */
router.get('/resume-status/:candidateAssessmentId', async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .select('resume status');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        res.json({
            success: true,
            data: {
                status: candidateAssessment.status,
                resume: {
                    matchScore: candidateAssessment.resume.matchScore,
                    passedThreshold: candidateAssessment.resume.passedThreshold,
                    isFake: candidateAssessment.resume.isFake,
                    analyzed: !!candidateAssessment.resume.analyzedAt,
                },
            },
        });
    } catch (error) {
        console.error('❌ Get resume status error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get resume status',
        });
    }
});

/**
 * GET /api/candidate/status/:candidateAssessmentId
 * Get full candidate status
 */
router.get('/status/:candidateAssessmentId', async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('jd', 'parsedContent.roleTitle assessmentConfig.totalTimeMinutes assessmentConfig.sections company')
            .populate('assignedSet', 'setNumber');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        res.json({
            success: true,
            data: {
                status: candidateAssessment.status,
                onboarding: candidateAssessment.onboarding,
                resume: {
                    uploaded: !!candidateAssessment.resume.fileUrl || !!candidateAssessment.resume.parsedText,
                    matchScore: candidateAssessment.resume.matchScore,
                    passedThreshold: candidateAssessment.resume.passedThreshold,
                },
                assignedSet: candidateAssessment.assignedSet ? candidateAssessment.assignedSetNumber : null,
                roleTitle: candidateAssessment.jd?.parsedContent?.roleTitle,
                totalTimeMinutes: candidateAssessment.jd?.assessmentConfig?.totalTimeMinutes,
                sections: candidateAssessment.jd?.assessmentConfig?.sections,
                canStart: candidateAssessment.isOnboardingComplete(),
            },
        });
    } catch (error) {
        console.error('❌ Get status error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get status',
        });
    }
});

/**
 * POST /api/candidate/start/:candidateAssessmentId
 * Start the assessment (assigns a set, creates session)
 */
router.post('/start/:candidateAssessmentId', async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('jd');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Assessment not found',
            });
        }

        // Validate onboarding complete
        if (!candidateAssessment.isOnboardingComplete()) {
            return res.status(400).json({
                success: false,
                error: 'Please complete onboarding first',
                missing: {
                    emailVerified: candidateAssessment.onboarding.emailVerified,
                    profilePhoto: candidateAssessment.onboarding.profilePhotoCaptured,
                    consent: candidateAssessment.onboarding.consentAccepted,
                    resumePassed: candidateAssessment.resume.passedThreshold,
                },
            });
        }

        // Check if already started - return existing session token
        if (candidateAssessment.status === 'in_progress' || candidateAssessment.startedAt) {
            return res.json({
                success: true,
                message: 'Assessment already in progress',
                data: {
                    sessionToken: candidateAssessment.sessionToken,
                    startedAt: candidateAssessment.startedAt,
                    totalTimeMinutes: candidateAssessment.jd.assessmentConfig.totalTimeMinutes,
                    currentSection: candidateAssessment.currentSection,
                    sections: candidateAssessment.jd.assessmentConfig.sections,
                },
            });
        }

        // Assign a random set if not already assigned
        if (!candidateAssessment.assignedSet) {
            const sets = await AssessmentSet.find({
                jd: candidateAssessment.jd._id,
                isActive: true,
            });

            if (sets.length === 0) {
                return res.status(500).json({
                    success: false,
                    error: 'No question sets available',
                });
            }

            // Random assignment
            const randomSet = sets[Math.floor(Math.random() * sets.length)];
            candidateAssessment.assignedSet = randomSet._id;
            candidateAssessment.assignedSetNumber = randomSet.setNumber;
            candidateAssessment.assignedAt = new Date();
        }

        // Create session
        candidateAssessment.sessionToken = CandidateAssessment.generateSessionToken();
        candidateAssessment.sessionCreatedAt = new Date();
        candidateAssessment.startedAt = new Date();
        candidateAssessment.status = 'in_progress';
        candidateAssessment.currentSection = 'objective'; // Start with objective
        candidateAssessment.lastHeartbeat = new Date();

        // Track IP if available
        candidateAssessment.ipAddress = req.ip || req.headers['x-forwarded-for'] || '';
        candidateAssessment.userAgent = req.headers['user-agent'] || '';

        await candidateAssessment.save();

        // Mark onboarding complete
        candidateAssessment.onboarding.onboardingCompletedAt = new Date();
        await candidateAssessment.save();

        res.json({
            success: true,
            message: 'Assessment started',
            data: {
                sessionToken: candidateAssessment.sessionToken,
                startedAt: candidateAssessment.startedAt,
                totalTimeMinutes: candidateAssessment.jd.assessmentConfig.totalTimeMinutes,
                currentSection: candidateAssessment.currentSection,
                sections: candidateAssessment.jd.assessmentConfig.sections,
            },
        });
    } catch (error) {
        console.error('❌ Start assessment error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start assessment',
        });
    }
});

// ============================================================================
// HELPER: Resume Matching (Background Task)
// ============================================================================

async function matchResumeWithJD(candidateAssessmentId) {
    try {
        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('jd');

        if (!candidateAssessment) {
            console.error('❌ CandidateAssessment not found:', candidateAssessmentId);
            return null;
        }

        const jd = candidateAssessment.jd;
        const resumeText = candidateAssessment.resume.parsedText;

        if (!resumeText) {
            console.error('❌ No resume text to match');
            return candidateAssessment;
        }

        const prompt = `You are an expert technical recruiter specializing in identifying high-potential talent. Your task is to perform an in-depth scoring of the following Resume against the Job Description (JD).

### SCORING RUBRIC (Total 100 points)
1. **Applied Technical Skills (40 points)**: 
   - **Crucial**: Do NOT solely rely on the "Skills" header. Analyze the projects and work experience to find evidence of skill application.
   - **Evidence in Projects/Work**: High weight. Look for specific libraries, frameworks, and architecture patterns mentioned in project descriptions.
   - **Matched Skills**: Compare the found skills against the ${jd.parsedContent?.technicalSkills?.length || 0} required skills in the JD.

2. **Project Complexity & Innovation (40 points)**:
   - Evaluate the scale, depth, and technical challenge of the candidate's projects.
   - Real-world deployments, integration of multiple technologies (e.g., AI + WebSockets + DB), and complex problem-solving score highly.
   - For students/freshers, high-quality projects are the primary indicator of capability.

3. **Experience & Contextual Fit (20 points)**:
   - **Important**: If the JD accepts candidates who are "pursuing" a degree or are "freshers", treat high-quality, long-term projects as professional-grade experience.
   - Assess the years of experience relative to the requirement (${jd.parsedContent?.yearsOfExperience?.min || 0} years).

### INPUT DATA
JOB DESCRIPTION:
Role: ${jd.parsedContent?.roleTitle || 'Not specified'}
Required Skills: ${jd.parsedContent?.technicalSkills?.map(s => s.name).join(', ') || 'Not specified'}
Experience Level: ${jd.parsedContent?.experienceLevel || 'fresher'}
Target Years: ${jd.parsedContent?.yearsOfExperience?.min || 0} - ${jd.parsedContent?.yearsOfExperience?.max || 0}

RESUME TEXT:
${resumeText.substring(0, 4000)}

### EXECUTION RULES:
- **Be Fair to Potential**: If a candidate shows exceptional technical depth in projects that match the company's tech stack (React, Node, AI), score them highly even if they are still students.
- **Evidence-Based**: Award points based on *what they built* and *how they built it*.
- **Consistency**: Maintain a logical point distribution.
- **Tone**: Professional, analytical, and fair.

### OUTPUT FORMAT (JSON ONLY)
{
  "matchScore": number (0-100),
  "scoreJustification": "DETAILED breakdown: [Skills: X/40, Projects: X/40, Fit: X/20]. Explain why points were given/withheld.",
  "skillMatches": [
    {"skill": "string", "matched": boolean, "confidence": 0-100, "evidenceFoundInProjects": boolean}
  ],
  "experienceMatch": boolean,
  "qualificationMatch": boolean,
  "isFake": boolean,
  "fakeReasons": ["string"],
  "overallAnalysis": "Focus on technical depth and project implementation quality."
}

Return ONLY valid JSON.`;

        try {
            const analysis = await callOpenAI(prompt, process.env.OPENAI_MODEL || 'gpt-4o', true, 3, 0.1);

            // Get threshold from JD (Update default to 70 in logic too)
            const threshold = jd.assessmentConfig?.resumeMatchThreshold || 70;

            // Update candidate assessment
            candidateAssessment.resume.matchScore = analysis.matchScore || 0;
            candidateAssessment.resume.matchDetails = {
                skillMatches: analysis.skillMatches || [],
                experienceMatch: analysis.experienceMatch || false,
                qualificationMatch: analysis.qualificationMatch || false,
                overallAnalysis: analysis.overallAnalysis || '',
            };
            candidateAssessment.resume.isFake = analysis.isFake || false;
            candidateAssessment.resume.fakeReasons = analysis.fakeReasons || [];
            candidateAssessment.resume.passedThreshold = analysis.matchScore >= threshold && !analysis.isFake;
            candidateAssessment.resume.analyzedAt = new Date();

            if (candidateAssessment.resume.passedThreshold) {
                candidateAssessment.status = 'ready';
            } else {
                candidateAssessment.status = 'resume_rejected';
            }

            await candidateAssessment.save();
            console.log(`✅ Resume matched for ${candidateAssessmentId}: score = ${analysis.matchScore}, passed = ${candidateAssessment.resume.passedThreshold} `);
            return candidateAssessment;

        } catch (parseError) {
            console.error('❌ Error parsing AI response:', parseError);
            candidateAssessment.resume.analyzedAt = new Date();
            candidateAssessment.resume.matchScore = 0;
            candidateAssessment.status = 'resume_rejected';
            await candidateAssessment.save();
            return candidateAssessment;
        }

    } catch (error) {
        console.error('❌ Resume matching error:', error);
        return null;
    }
}

// ============================================================================
// CANDIDATE PROFILE & HISTORY (Authenticated)
// ============================================================================

/**
 * GET /api/candidate/profile
 * Get candidate's own profile
 */
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'candidate') {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const user = await User.findById(req.user._id).select('-password');

        res.json({
            success: true,
            data: {
                id: user._id,
                email: user.email,
                username: user.username,
                name: user.name,
                role: user.role,
                profileImageUrl: user.profileImageUrl,
            },
        });
    } catch (error) {
        console.error('❌ Get candidate profile error:', error);
        res.status(500).json({ success: false, error: 'Failed to get profile' });
    }
});

/**
 * PUT /api/candidate/profile
 * Update candidate's own profile
 */
router.put('/profile', authenticateToken, [
    body('username').optional().trim().isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/).withMessage('Username must be 3-20 characters with letters, numbers, and underscores'),
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
], async (req, res) => {
    try {
        if (req.user.role !== 'candidate') {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { name, username } = req.body;
        const user = await User.findById(req.user._id);

        if (name) user.name = name;

        if (username) {
            const existingUser = await User.findOne({ username, _id: { $ne: user._id } });
            if (existingUser) {
                return res.status(400).json({ success: false, error: 'Username already taken' });
            }
            user.username = username;
        }

        await user.save();

        res.json({
            success: true,
            message: 'Profile updated successfully',
            data: {
                id: user._id,
                email: user.email,
                username: user.username,
                name: user.name,
            },
        });
    } catch (error) {
        console.error('❌ Update candidate profile error:', error);
        res.status(500).json({ success: false, error: 'Failed to update profile' });
    }
});

/**
 * GET /api/candidate/history
 * Get candidate's assessment history
 */
router.get('/history', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'candidate') {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const assessments = await CandidateAssessment.find({
            candidate: req.user._id,
        })
            .populate({
                path: 'jd',
                populate: { path: 'company', select: 'name' },
                select: 'parsedContent company',
            })
            .select('status evaluation adminDecision resultReleasedAt submittedAt totalScore sectionScores')
            .sort({ submittedAt: -1 });

        const history = assessments.map((a) => ({
            _id: a._id,
            companyName: a.jd?.company?.name || 'Company',
            roleTitle: a.jd?.parsedContent?.roleTitle || 'Position',
            submittedAt: a.submittedAt,
            status: a.status,
            adminDecision: a.adminDecision,
            resultReleased: !!a.resultReleasedAt,
            // Only include scores if result is released
            ...(a.resultReleasedAt && {
                totalScore: a.evaluation?.totalScore || a.totalScore,
                sectionScores: a.evaluation?.sectionScores || a.sectionScores,
                showDetails: true,
            }),
        }));

        res.json({
            success: true,
            data: history,
        });
    } catch (error) {
        console.error('❌ Get candidate history error:', error);
        res.status(500).json({ success: false, error: 'Failed to get assessment history' });
    }
});

/**
 * GET /api/candidate/history/:assessmentId
 * Get details of a specific assessment (only if result released)
 */
router.get('/history/:assessmentId', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'candidate') {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const assessment = await CandidateAssessment.findOne({
            _id: req.params.assessmentId,
            candidate: req.user._id,
        })
            .populate({
                path: 'jd',
                populate: { path: 'company', select: 'name' },
                select: 'parsedContent company',
            });

        if (!assessment) {
            return res.status(404).json({ success: false, error: 'Assessment not found' });
        }

        // Check if result is released
        if (!assessment.resultReleasedAt) {
            return res.json({
                success: true,
                data: {
                    _id: assessment._id,
                    companyName: assessment.jd?.company?.name || 'Company',
                    roleTitle: assessment.jd?.parsedContent?.roleTitle || 'Position',
                    submittedAt: assessment.submittedAt,
                    status: 'pending_review',
                    resultReleased: false,
                },
            });
        }

        // Return full details
        res.json({
            success: true,
            data: {
                _id: assessment._id,
                companyName: assessment.jd?.company?.name || 'Company',
                roleTitle: assessment.jd?.parsedContent?.roleTitle || 'Position',
                submittedAt: assessment.submittedAt,
                status: assessment.status,
                adminDecision: assessment.adminDecision,
                resultReleased: true,
                evaluation: assessment.evaluation,
                totalScore: assessment.evaluation?.totalScore,
                sectionScores: assessment.evaluation?.sectionScores,
            },
        });
    } catch (error) {
        console.error('❌ Get assessment detail error:', error);
        res.status(500).json({ success: false, error: 'Failed to get assessment details' });
    }
});

export default router;

