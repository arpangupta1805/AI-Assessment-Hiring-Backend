import express from 'express';
import { body, validationResult } from 'express-validator';
import EmailTemplate from '../models/EmailTemplate.js';
import CandidateAssessment from '../models/CandidateAssessment.js';
import Evaluation from '../models/Evaluation.js';
import ProctoringEvent from '../models/ProctoringEvent.js';
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
        const { resultType, customMessage, selectedProctoringEvents, includeReport } = req.body;

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

        // --- Fetch Additional Data ---
        let reportHtml = '';

        // 1. Evaluation Report
        if (includeReport) {
            const evaluation = await Evaluation.findOne({ candidateAssessment: candidateAssessment._id });
            if (evaluation) {
                reportHtml += `
                    <div style="margin-top: 20px; border-top: 1px solid #ddd; padding-top: 20px;">
                        <h3 style="color: #333;">Assessment Result Summary</h3>
                        <p><strong>Total Score:</strong> ${evaluation.percentage.toFixed(1)}%</p>
                        <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">
                            <tr style="background-color: #f9f9f9; text-align: left;">
                                <th style="padding: 8px; border: 1px solid #ddd;">Section</th>
                                <th style="padding: 8px; border: 1px solid #ddd;">Score</th>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Objective</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">${evaluation.sections.objective.percentage.toFixed(1)}%</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Subjective (AI)</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">${evaluation.sections.subjective.percentage.toFixed(1)}%</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">Programming</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">${evaluation.sections.programming.percentage.toFixed(1)}%</td>
                            </tr>
                        </table>
                        
                        ${evaluation.recommendation ? `
                        <div style="background-color: #f0f7ff; padding: 10px; border-left: 4px solid #0066cc; margin-bottom: 15px;">
                            <strong>AI Recommendation:</strong> ${evaluation.recommendation.action}
                            <p style="margin: 5px 0 0 0; font-size: 0.9em;">${evaluation.recommendation.reason}</p>
                        </div>` : ''}
                    </div>
                `;
            }
        }

        // 2. Proctoring Events
        if (selectedProctoringEvents && selectedProctoringEvents.length > 0) {
            const events = await ProctoringEvent.find({ _id: { $in: selectedProctoringEvents } });

            if (events.length > 0) {
                reportHtml += `
                    <div style="margin-top: 20px; border-top: 1px solid #ddd; padding-top: 20px;">
                        <h3 style="color: #d32f2f;">Proctoring Flags</h3>
                        <p>The following irregularities were noted during the assessment:</p>
                        <ul style="color: #d32f2f;">
                `;

                events.forEach(event => {
                    const cleanType = event.eventType.replace(/_/g, ' ').toUpperCase();
                    reportHtml += `<li><strong>${cleanType}:</strong> ${event.evidence?.aiAnalysis?.briefReason || event.description || 'Detected via proctoring system'}</li>`;
                });

                reportHtml += `</ul></div>`;
            }
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
        // We inject reportHtml into {{assessmentReport}} placeholder if it exists, or append it
        let { subject, body } = template.render({
            candidateName: candidateAssessment.candidate.name,
            roleTitle: candidateAssessment.jd.parsedContent?.roleTitle || 'Position',
            companyName: candidateAssessment.jd.company.name,
            assessmentReport: reportHtml, // Inject report
        });

        // If template doesn't have {{assessmentReport}}, append it to body if reportHtml is not empty
        if (reportHtml && !body.includes(reportHtml) && !template.body.includes('{{assessmentReport}}')) {
            body += reportHtml;
        }

        // Send email
        await emailService.sendEmail(
            candidateAssessment.candidate.email,
            subject,
            customMessage ? (customMessage + reportHtml) : body
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
