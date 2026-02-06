import mongoose from 'mongoose';

/**
 * Proctoring Event Model
 * Logs all proctoring events without auto-disqualification
 * Admin reviews these events to make final decisions
 */
const ProctoringEventSchema = new mongoose.Schema(
    {
        candidateAssessment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CandidateAssessment',
            required: true,
        },

        // Event type classification
        eventType: {
            type: String,
            enum: [
                'tab_switch',          // Candidate switched browser tabs
                'window_blur',         // Browser window lost focus
                'multiple_faces',      // More than one face detected
                'no_face',             // No face detected
                'face_not_centered',   // Face moved out of frame
                'device_detected',     // Mobile/electronic device detected
                'external_screen',     // External screen/display detected
                'copy_paste',          // Copy/paste attempt
                'right_click',         // Right-click context menu
                'keyboard_shortcut',   // Suspicious keyboard shortcut
                'idle',                // Extended idle period
                'suspicious_behavior', // Generic suspicious activity
                'browser_resize',      // Browser window resized
                'fullscreen_exit',     // Exited fullscreen mode
                'dev_tools',           // Developer tools opened
            ],
            required: true,
        },

        // Timing
        timestamp: {
            type: Date,
            default: Date.now,
        },
        duration: {
            type: Number, // Duration in seconds (for idle, tab switch duration)
            default: 0,
        },

        // Severity for prioritization
        severity: {
            type: String,
            enum: ['low', 'medium', 'high'],
            default: 'medium',
        },

        // Evidence
        screenshot: {
            type: String, // Base64 or URL
            default: '',
        },

        // Additional context
        evidence: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },

        // What section/question was active
        context: {
            section: { type: String, enum: ['objective', 'subjective', 'programming'] },
            questionIndex: { type: Number },
            questionId: { type: String },
        },

        // Admin review
        reviewedByAdmin: {
            type: Boolean,
            default: false,
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        adminNotes: {
            type: String,
            default: '',
        },
        adminVerdict: {
            type: String,
            enum: ['genuine', 'suspicious', 'violation', 'dismissed'],
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
ProctoringEventSchema.index({ candidateAssessment: 1, createdAt: -1 });
ProctoringEventSchema.index({ candidateAssessment: 1, eventType: 1 });
ProctoringEventSchema.index({ candidateAssessment: 1, severity: 1 });
ProctoringEventSchema.index({ reviewedByAdmin: 1 });

// Severity mapping for event types
ProctoringEventSchema.statics.getSeverityForEvent = function (eventType) {
    const severityMap = {
        'tab_switch': 'medium',
        'window_blur': 'low',
        'multiple_faces': 'high',
        'no_face': 'medium',
        'face_not_centered': 'low',
        'device_detected': 'high',
        'external_screen': 'high',
        'copy_paste': 'high',
        'right_click': 'low',
        'keyboard_shortcut': 'medium',
        'idle': 'low',
        'suspicious_behavior': 'medium',
        'browser_resize': 'low',
        'fullscreen_exit': 'medium',
        'dev_tools': 'high',
    };
    return severityMap[eventType] || 'medium';
};

const ProctoringEvent = mongoose.model('ProctoringEvent', ProctoringEventSchema);

export default ProctoringEvent;
