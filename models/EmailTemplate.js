import mongoose from 'mongoose';

/**
 * Email Template Model
 * Stores customizable email templates for candidate communications
 */
const EmailTemplateSchema = new mongoose.Schema(
    {
        company: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Company',
            default: null, // null = system default template
        },

        templateType: {
            type: String,
            enum: [
                'assessment_invite',      // Invite to take assessment
                'otp_verification',       // OTP for email verification
                'submission_received',    // Assessment submitted confirmation
                'under_review',           // Status update - under review
                'result_pass',            // Result - passed
                'result_fail',            // Result - failed
                'reminder',               // Assessment reminder
                'expiry_warning',         // Assessment link expiring soon
            ],
            required: true,
        },

        subject: {
            type: String,
            required: true,
        },

        // HTML body with placeholders like {{candidateName}}, {{companyName}}, etc.
        body: {
            type: String,
            required: true,
        },

        // Available placeholders for this template
        placeholders: [{
            type: String,
        }],

        isActive: {
            type: Boolean,
            default: true,
        },

        isDefault: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
EmailTemplateSchema.index({ company: 1, templateType: 1 });
EmailTemplateSchema.index({ templateType: 1, isDefault: 1 });

// Get template with fallback to default
EmailTemplateSchema.statics.getTemplate = async function (companyId, templateType) {
    // First try company-specific template
    let template = await this.findOne({
        company: companyId,
        templateType,
        isActive: true,
    });

    // Fallback to default template
    if (!template) {
        template = await this.findOne({
            templateType,
            isDefault: true,
            isActive: true,
        });
    }

    return template;
};

// Replace placeholders in template
EmailTemplateSchema.methods.render = function (data) {
    let subject = this.subject;
    let body = this.body;

    Object.keys(data).forEach(key => {
        const placeholder = `{{${key}}}`;
        const value = data[key] || '';
        subject = subject.replace(new RegExp(placeholder, 'g'), value);
        body = body.replace(new RegExp(placeholder, 'g'), value);
    });

    return { subject, body };
};

// Seed default templates
EmailTemplateSchema.statics.seedDefaults = async function () {
    const defaults = [
        {
            templateType: 'assessment_invite',
            subject: 'You are invited to take an assessment for {{roleTitle}} at {{companyName}}',
            body: `
        <h2>Hello {{candidateName}},</h2>
        <p>You have been invited to take an assessment for the <strong>{{roleTitle}}</strong> position at <strong>{{companyName}}</strong>.</p>
        <p>Please click the link below to start your assessment:</p>
        <p><a href="{{assessmentLink}}">Start Assessment</a></p>
        <p>This assessment is valid until {{expiryDate}}.</p>
        <p>Good luck!</p>
        <p>Best regards,<br>{{companyName}} Hiring Team</p>
      `,
            placeholders: ['candidateName', 'roleTitle', 'companyName', 'assessmentLink', 'expiryDate'],
            isDefault: true,
        },
        {
            templateType: 'otp_verification',
            subject: 'Your verification code: {{otp}}',
            body: `
        <h2>Hello,</h2>
        <p>Your verification code is: <strong>{{otp}}</strong></p>
        <p>This code will expire in 10 minutes.</p>
        <p>If you did not request this code, please ignore this email.</p>
      `,
            placeholders: ['otp'],
            isDefault: true,
        },
        {
            templateType: 'submission_received',
            subject: 'Assessment Submitted - {{roleTitle}} at {{companyName}}',
            body: `
        <h2>Hello {{candidateName}},</h2>
        <p>Thank you for completing your assessment for <strong>{{roleTitle}}</strong> at <strong>{{companyName}}</strong>.</p>
        <p>Your submission has been received and is now under review.</p>
        <p>We will notify you once the evaluation is complete.</p>
        <p>Best regards,<br>{{companyName}} Hiring Team</p>
      `,
            placeholders: ['candidateName', 'roleTitle', 'companyName'],
            isDefault: true,
        },
        {
            templateType: 'under_review',
            subject: 'Your assessment is under review - {{companyName}}',
            body: `
        <h2>Hello {{candidateName}},</h2>
        <p>Your assessment for <strong>{{roleTitle}}</strong> is currently being reviewed by our team.</p>
        <p>We appreciate your patience and will get back to you soon.</p>
        <p>Best regards,<br>{{companyName}} Hiring Team</p>
      `,
            placeholders: ['candidateName', 'roleTitle', 'companyName'],
            isDefault: true,
        },
        {
            templateType: 'result_pass',
            subject: 'Congratulations! You passed the assessment - {{companyName}}',
            body: `
        <h2>Congratulations {{candidateName}}!</h2>
        <p>We are pleased to inform you that you have successfully passed the assessment for <strong>{{roleTitle}}</strong> at <strong>{{companyName}}</strong>.</p>
        <p>Our team will reach out to you shortly regarding the next steps.</p>
        <p>Best regards,<br>{{companyName}} Hiring Team</p>
      `,
            placeholders: ['candidateName', 'roleTitle', 'companyName'],
            isDefault: true,
        },
        {
            templateType: 'result_fail',
            subject: 'Assessment Update - {{companyName}}',
            body: `
        <h2>Hello {{candidateName}},</h2>
        <p>Thank you for taking the time to complete the assessment for <strong>{{roleTitle}}</strong> at <strong>{{companyName}}</strong>.</p>
        <p>After careful review, we have decided not to move forward with your application at this time.</p>
        <p>We encourage you to apply for future opportunities that match your skills.</p>
        <p>Best regards,<br>{{companyName}} Hiring Team</p>
      `,
            placeholders: ['candidateName', 'roleTitle', 'companyName'],
            isDefault: true,
        },
    ];

    for (const template of defaults) {
        await this.findOneAndUpdate(
            { templateType: template.templateType, isDefault: true },
            template,
            { upsert: true, new: true }
        );
    }
};

const EmailTemplate = mongoose.model('EmailTemplate', EmailTemplateSchema);

export default EmailTemplate;
