import express from 'express';
import JobDescription from '../models/JobDescription.js';
import CandidateAssessment from '../models/CandidateAssessment.js';
import Evaluation from '../models/Evaluation.js';
import ProctoringEvent from '../models/ProctoringEvent.js';
import AssessmentAnswer from '../models/AssessmentAnswer.js';
import { authenticateToken, requireRecruiter } from '../middleware/auth.js';

const router = express.Router();

// ============================================================================
// JD LISTING
// ============================================================================

/**
 * GET /api/admin/jds
 * Get all JDs for the recruiter's company
 */
router.get('/jds', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const jds = await JobDescription.find({ company: req.user.company })
            .sort({ createdAt: -1 })
            .select('parsedContent.roleTitle status stats assessmentConfig.startTime assessmentConfig.endTime assessmentConfig.assessmentLink createdAt')
            .lean();

        res.json({
            success: true,
            data: jds,
        });
    } catch (error) {
        console.error('❌ Get JDs error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch JDs',
        });
    }
});

// ============================================================================
// CANDIDATE LISTING
// ============================================================================

/**
 * GET /api/admin/candidates/:jdId
 * Get all candidates for a specific JD
 */
router.get('/candidates/:jdId', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { jdId } = req.params;
        const { status, page = 1, limit = 20 } = req.query;

        // Verify JD ownership
        const jd = await JobDescription.findOne({
            _id: jdId,
            company: req.user.company,
        });

        if (!jd) {
            return res.status(404).json({
                success: false,
                error: 'JD not found',
            });
        }

        // Build query
        const query = { jd: jdId };
        if (status) {
            query.status = status;
        }

        const total = await CandidateAssessment.countDocuments(query);

        const candidates = await CandidateAssessment.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .populate('candidate', 'name email')
            .lean();

        // Get evaluations for each candidate
        const evaluations = await Evaluation.find({
            candidateAssessment: { $in: candidates.map(c => c._id) },
        }).lean();

        const evaluationMap = {};
        evaluations.forEach(e => {
            evaluationMap[e.candidateAssessment.toString()] = e;
        });

        const enrichedCandidates = candidates.map(c => ({
            ...c,
            evaluation: evaluationMap[c._id.toString()] || null,
        }));

        res.json({
            success: true,
            data: {
                candidates: enrichedCandidates,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / limit),
                },
            },
        });
    } catch (error) {
        console.error('❌ Get candidates error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch candidates',
        });
    }
});

/**
 * GET /api/admin/candidate/:candidateAssessmentId
 * Get full details for a single candidate
 */
router.get('/candidate/:candidateAssessmentId', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('candidate', 'name email phone webcamPhoto')
            .populate('jd', 'company parsedContent.roleTitle assessmentConfig')
            .populate('assignedSet');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Candidate not found',
            });
        }

        // Verify ownership
        if (candidateAssessment.jd.company.toString() !== req.user.company.toString()) {
            return res.status(403).json({
                success: false,
                error: 'Access denied',
            });
        }

        // Get evaluation
        const evaluation = await Evaluation.findOne({ candidateAssessment: candidateAssessmentId });

        // Get answers
        const answers = await AssessmentAnswer.find({ candidateAssessment: candidateAssessmentId });

        // Get proctoring events summary
        const proctoringStats = await ProctoringEvent.aggregate([
            { $match: { candidateAssessment: candidateAssessment._id } },
            {
                $group: {
                    _id: '$severity',
                    count: { $sum: 1 },
                },
            },
        ]);

        res.json({
            success: true,
            data: {
                candidateAssessment,
                evaluation,
                answers,
                proctoringStats,
            },
        });
    } catch (error) {
        console.error('❌ Get candidate details error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch candidate details',
        });
    }
});

// ============================================================================
// PROCTORING
// ============================================================================

/**
 * GET /api/admin/proctoring/:candidateAssessmentId
 * Get all proctoring events for a candidate
 */
router.get('/proctoring/:candidateAssessmentId', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { candidateAssessmentId } = req.params;
        const { severity, reviewed } = req.query;

        const candidateAssessment = await CandidateAssessment.findById(candidateAssessmentId)
            .populate('jd', 'company');

        if (!candidateAssessment) {
            return res.status(404).json({
                success: false,
                error: 'Candidate not found',
            });
        }

        // Verify ownership
        if (candidateAssessment.jd.company.toString() !== req.user.company.toString()) {
            return res.status(403).json({
                success: false,
                error: 'Access denied',
            });
        }

        // Build query
        const query = { candidateAssessment: candidateAssessment._id };
        if (severity) {
            query.severity = severity;
        }
        if (reviewed !== undefined) {
            query.reviewedByAdmin = reviewed === 'true';
        }

        const events = await ProctoringEvent.find(query)
            .sort({ timestamp: -1 })
            .lean();

        // Summary
        const summary = {
            total: events.length,
            high: events.filter(e => e.severity === 'high').length,
            medium: events.filter(e => e.severity === 'medium').length,
            low: events.filter(e => e.severity === 'low').length,
            unreviewed: events.filter(e => !e.reviewedByAdmin).length,
        };

        res.json({
            success: true,
            data: {
                events,
                summary,
            },
        });
    } catch (error) {
        console.error('❌ Get proctoring events error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch proctoring events',
        });
    }
});

/**
 * PUT /api/admin/proctoring/:eventId/review
 * Review a proctoring event
 */
router.put('/proctoring/:eventId/review', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { eventId } = req.params;
        const { verdict, notes } = req.body;

        const event = await ProctoringEvent.findById(eventId)
            .populate({
                path: 'candidateAssessment',
                populate: { path: 'jd', select: 'company' },
            });

        if (!event) {
            return res.status(404).json({
                success: false,
                error: 'Event not found',
            });
        }

        // Verify ownership
        if (event.candidateAssessment.jd.company.toString() !== req.user.company.toString()) {
            return res.status(403).json({
                success: false,
                error: 'Access denied',
            });
        }

        event.reviewedByAdmin = true;
        event.reviewedAt = new Date();
        event.reviewedBy = req.user._id;
        event.adminNotes = notes || '';
        event.adminVerdict = verdict || null;
        await event.save();

        res.json({
            success: true,
            message: 'Event reviewed',
        });
    } catch (error) {
        console.error('❌ Review event error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to review event',
        });
    }
});

// ============================================================================
// ANALYTICS
// ============================================================================

/**
 * GET /api/admin/analytics/:jdId
 * Get analytics for a JD
 */
router.get('/analytics/:jdId', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { jdId } = req.params;

        // Verify JD ownership
        const jd = await JobDescription.findOne({
            _id: jdId,
            company: req.user.company,
        });

        if (!jd) {
            return res.status(404).json({
                success: false,
                error: 'JD not found',
            });
        }

        // Get all candidate assessments
        const candidates = await CandidateAssessment.find({ jd: jdId });

        // Get all evaluations
        const evaluations = await Evaluation.find({
            candidateAssessment: { $in: candidates.map(c => c._id) },
        });

        // Calculate stats
        const totalCandidates = candidates.length;
        const completedCount = candidates.filter(c => c.status === 'submitted' || c.status === 'evaluated' || c.status === 'decided').length;
        const inProgressCount = candidates.filter(c => c.status === 'in_progress').length;
        const evaluatedCount = evaluations.length;

        const scores = evaluations.map(e => e.percentage || 0).filter(s => s > 0);
        const averageScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        const passCount = evaluations.filter(e => e.adminDecision === 'PASS').length;
        const failCount = evaluations.filter(e => e.adminDecision === 'FAIL').length;
        const pendingDecision = evaluations.filter(e => e.adminDecision === 'REVIEW_PENDING').length;

        // Score distribution
        const scoreDistribution = {
            '0-20': scores.filter(s => s < 20).length,
            '20-40': scores.filter(s => s >= 20 && s < 40).length,
            '40-60': scores.filter(s => s >= 40 && s < 60).length,
            '60-80': scores.filter(s => s >= 60 && s < 80).length,
            '80-100': scores.filter(s => s >= 80).length,
        };

        // Status breakdown
        const statusBreakdown = {};
        candidates.forEach(c => {
            statusBreakdown[c.status] = (statusBreakdown[c.status] || 0) + 1;
        });

        res.json({
            success: true,
            data: {
                totalCandidates,
                completedCount,
                inProgressCount,
                evaluatedCount,
                averageScore,
                passCount,
                failCount,
                pendingDecision,
                scoreDistribution,
                statusBreakdown,
            },
        });
    } catch (error) {
        console.error('❌ Get analytics error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch analytics',
        });
    }
});

// ============================================================================
// EXPORT
// ============================================================================

/**
 * GET /api/admin/export/:jdId
 * Export candidates data as CSV
 */
router.get('/export/:jdId', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { jdId } = req.params;
        const { format = 'json' } = req.query;

        // Verify JD ownership
        const jd = await JobDescription.findOne({
            _id: jdId,
            company: req.user.company,
        });

        if (!jd) {
            return res.status(404).json({
                success: false,
                error: 'JD not found',
            });
        }

        const candidates = await CandidateAssessment.find({ jd: jdId })
            .populate('candidate', 'name email')
            .lean();

        const evaluations = await Evaluation.find({
            candidateAssessment: { $in: candidates.map(c => c._id) },
        }).lean();

        const evaluationMap = {};
        evaluations.forEach(e => {
            evaluationMap[e.candidateAssessment.toString()] = e;
        });

        const exportData = candidates.map(c => {
            const eval_ = evaluationMap[c._id.toString()];
            return {
                name: c.candidate?.name || '',
                email: c.candidate?.email || '',
                status: c.status,
                resumeMatchScore: c.resume?.matchScore || 0,
                startedAt: c.startedAt,
                submittedAt: c.submittedAt,
                timeSpentMinutes: Math.round((c.timeSpentSeconds || 0) / 60),
                objectiveScore: eval_?.sections?.objective?.percentage || 0,
                subjectiveScore: eval_?.sections?.subjective?.percentage || 0,
                programmingScore: eval_?.sections?.programming?.percentage || 0,
                totalScore: eval_?.percentage || 0,
                aiRecommendation: eval_?.aiRecommendation || '',
                adminDecision: eval_?.adminDecision || '',
                integrityStatus: c.integrityStatus,
                proctoringEventsCount: c.proctoringStats?.totalEvents || 0,
            };
        });

        if (format === 'csv') {
            // Generate CSV
            const headers = Object.keys(exportData[0] || {}).join(',');
            const rows = exportData.map(row =>
                Object.values(row).map(v => `"${v}"`).join(',')
            ).join('\n');
            const csv = headers + '\n' + rows;

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="candidates-${jdId}.csv"`);
            return res.send(csv);
        }

        res.json({
            success: true,
            data: exportData,
        });
    } catch (error) {
        console.error('❌ Export error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to export data',
        });
    }
});

// ============================================================================
// AUDIT LOG
// ============================================================================

/**
 * GET /api/admin/audit-log
 * Get audit log for company
 */
router.get('/audit-log', authenticateToken, requireRecruiter, async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;

        // Get all JDs for company
        const jdIds = await JobDescription.find({ company: req.user.company }).distinct('_id');

        // Get evaluations with admin decisions as audit entries
        const auditEntries = await Evaluation.find({
            candidateAssessment: { $in: await CandidateAssessment.find({ jd: { $in: jdIds } }).distinct('_id') },
            adminDecisionAt: { $ne: null },
        })
            .sort({ adminDecisionAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .populate({
                path: 'candidateAssessment',
                populate: [
                    { path: 'candidate', select: 'name email' },
                    { path: 'jd', select: 'parsedContent.roleTitle' },
                ],
            })
            .populate('adminDecisionBy', 'name email')
            .lean();

        res.json({
            success: true,
            data: auditEntries.map(e => ({
                timestamp: e.adminDecisionAt,
                action: 'DECISION_MADE',
                decision: e.adminDecision,
                candidateName: e.candidateAssessment?.candidate?.name,
                candidateEmail: e.candidateAssessment?.candidate?.email,
                roleTitle: e.candidateAssessment?.jd?.parsedContent?.roleTitle,
                decidedBy: e.adminDecisionBy?.name || e.adminDecisionBy?.email,
                notes: e.adminNotes,
            })),
        });
    } catch (error) {
        console.error('❌ Audit log error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch audit log',
        });
    }
});

export default router;
