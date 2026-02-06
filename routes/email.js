import express from 'express';
import { body, validationResult } from 'express-validator';
import EmailTemplate from '../models/EmailTemplate.js';
import CandidateAssessment from '../models/CandidateAssessment.js';
import Evaluation from '../models/Evaluation.js';
import User from '../models/User.js';
import { authenticateToken, requireRecruiter } from '../middleware/auth.js';
import emailService from '../services/emailService.js';

const router = express.Router();

// ============================================================================
// EMAIL TEMPLATE ROUTES
// ============================================================================

/**
 * GET /api/email/templates
 * Get all email templates for the company
 */
router.get('/templates', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        // Get company templates
        const companyTemplates = await EmailTemplate.find({
            company: req.user.company,
        }).lean();

        // Get default templates
        const defaultTemplates = await EmailTemplate.find({
            isDefault: true,
        }).lean();

        res.json({
            success: true,
            data: {
                companyTemplates,
                defaultTemplates,
            },
        });
    } catch (error) {
        console.error('❌ Get templates error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch templates',
        });
    }
});

/**
 * PUT /api/email/template/:templateType
 * Create or update company-specific template
 */
router.put('/template/:templateType', authenticateToken, requireRecruiter, [
    body('subject').notEmpty().withMessage('Subject required'),
    body('body').notEmpty().withMessage('Body required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { templateType } = req.params;
        const { subject, body, placeholders } = req.body;

        const template = await EmailTemplate.findOneAndUpdate(
            { company: req.user.company, templateType },
            {
                company: req.user.company,
                templateType,
                subject,
                body,
                placeholders: placeholders || [],
                isDefault: false,
            },
            { upsert: true, new: true }
        );

        res.json({
            success: true,
            data: template,
        });
    } catch (error) {
        console.error('❌ Update template error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update template',
        });
    }
});

// ============================================================================
// SEND EMAIL ROUTES
// ============================================================================

/**
 * POST /api/email/send-result/:candidateAssessmentId
 * Send result email to candidate (pass/fail)
 */
router.post('/send-result/:candidateAssessmentId', authenticateToken, requireRecruiter, [
    body('resultType').isIn(['pass', 'fail']).withMessage('Invalid result type'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { candidateAssessmentId } = req.params;
        const { resultType, customMessage } = req.body;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('candidate', 'name email')
            .populate({
                path: 'jd',
                populate: { path: 'company', select: 'name' },
            });

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Candidate not found',
            });
        }

        // Verify ownership
        if (candidateAssessment.jd.company._id.toString() !== req.user.company.toString()) {
            return res.status(403).json({
                success: false,
                error: 'Access denied',
            });
        }

        // Get template
        const templateType = resultType === 'pass' ? 'result_pass' : 'result_fail';
        const template = await EmailTemplate.getTemplate(req.user.company, templateType);

        if (!template) {
            return res.status(404).json({
                success: false,
                error: 'Email template not found',
            });
        }

        // Render template
        const { subject, body } = template.render({
            candidateName: candidateAssessment.candidate.name,
            roleTitle: candidateAssessment.jd.parsedContent?.roleTitle || 'Position',
            companyName: candidateAssessment.jd.company.name,
        });

        // Send email
        await emailService.sendEmail(
            candidateAssessment.candidate.email,
            subject,
            customMessage ? customMessage : body
        );

        // Update candidate assessment
        candidateAssessment.communicationLog.push({
            type: templateType,
            sentAt: new Date(),
            sentBy: req.user._id,
            subject,
        });
        await candidateAssessment.save();

        res.json({
            success: true,
            message: 'Email sent successfully',
        });
    } catch (error) {
        console.error('❌ Send result email error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send email',
        });
    }
});

/**
 * POST /api/email/send-bulk
 * Send bulk emails to multiple candidates
 */
router.post('/send-bulk', authenticateToken, requireRecruiter, [
    body('candidateIds').isArray().withMessage('Candidate IDs required'),
    body('templateType').notEmpty().withMessage('Template type required'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { candidateIds, templateType, customSubject, customBody } = req.body;

        // Get template
        const template = await EmailTemplate.getTemplate(req.user.company, templateType);

        if (!template && !customSubject && !customBody) {
            return res.status(404).json({
                success: false,
                error: 'Template not found and no custom content provided',
            });
        }

        const results = {
            sent: 0,
            failed: 0,
            errors: [],
        };

        for (const candidateId of candidateIds) {
            try {
                const candidateAssessment = await CandidateAssessment.findById(candidateId)
                    .populate('candidate', 'name email')
                    .populate({
                        path: 'jd',
                        populate: { path: 'company', select: 'name' },
                    });

                if (!candidateAssessment) continue;

                // Verify ownership
                if (candidateAssessment.jd.company._id.toString() !== req.user.company.toString()) {
                    continue;
                }

                // Render or use custom
                let subject, body;
                if (customSubject && customBody) {
                    subject = customSubject;
                    body = customBody;
                } else {
                    const rendered = template.render({
                        candidateName: candidateAssessment.candidate.name,
                        roleTitle: candidateAssessment.jd.parsedContent?.roleTitle || 'Position',
                        companyName: candidateAssessment.jd.company.name,
                    });
                    subject = rendered.subject;
                    body = rendered.body;
                }

                await emailService.sendEmail(
                    candidateAssessment.candidate.email,
                    subject,
                    body
                );

                // Log
                candidateAssessment.communicationLog.push({
                    type: templateType,
                    sentAt: new Date(),
                    sentBy: req.user._id,
                    subject,
                });
                await candidateAssessment.save();

                results.sent++;
            } catch (err) {
                results.failed++;
                results.errors.push({ candidateId, error: err.message });
            }
        }

        res.json({
            success: true,
            data: results,
        });
    } catch (error) {
        console.error('❌ Send bulk email error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send bulk emails',
        });
    }
});

/**
 * GET /api/email/history/:candidateAssessmentId
 * Get email history for a candidate
 */
router.get('/history/:candidateAssessmentId', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .select('communicationLog')
            .populate('communicationLog.sentBy', 'name email');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Candidate not found',
            });
        }

        res.json({
            success: true,
            data: candidateAssessment.communicationLog || [],
        });
    } catch (error) {
        console.error('❌ Get email history error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch email history',
        });
    }
});

export default router;
