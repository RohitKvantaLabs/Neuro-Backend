const nodemailer = require('nodemailer');
const logger = require('./logger');

// ponytail: Gmail SMTP transporter — credentials from env, never hardcoded
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendOtpEmail(to, otp, purpose) {
  const subjects = {
    REGISTRATION: 'Your Neuro Platform verification code',
    LOGIN_2FA: 'Your Neuro Platform admin login code',
    PASSWORD_RESET: 'Your Neuro Platform password reset code',
  };
  const subject = subjects[purpose] || 'Your Neuro Platform code';

  const titles = {
    REGISTRATION: 'Verify your email to finish registering',
    LOGIN_2FA: 'Verify your identity to log in',
    PASSWORD_RESET: 'Reset your password',
  };
  const title = titles[purpose] || 'Verify your verification code';

  const descriptions = {
    REGISTRATION: `Use this code to verify <strong>${to}</strong> and finish creating your NeuroSearch AI account:`,
    LOGIN_2FA: `Use this code to verify <strong>${to}</strong> and finish logging in to your NeuroSearch AI account:`,
    PASSWORD_RESET: `Use this code to verify <strong>${to}</strong> and finish resetting your NeuroSearch AI password:`,
  };
  const description = descriptions[purpose] || `Use this code to verify <strong>${to}</strong>:`;

  const spacedOtp = otp.split('').join('&nbsp;&nbsp;');

  // ponytail: Inline-styled, table-based, dark-navy theme email template for cross-client reliability
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #090f1d; -webkit-text-size-adjust: 100%;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #090f1d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="500" border="0" cellspacing="0" cellpadding="0" style="max-width: 500px; background-color: #0e1628; border-radius: 12px; overflow: hidden; border: 1px solid #1e293b; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);">
          <!-- Header -->
          <tr style="background-color: #02162e;">
            <td align="center" style="padding: 20px 0; border-bottom: 1px solid #1e293b;">
              <table border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align: middle; padding-right: 10px;">
                    <div style="background-color: #00e5ff; width: 36px; height: 36px; border-radius: 50%; display: table-cell; vertical-align: middle; text-align: center;">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
                        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
                        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
                        <path d="M12 5v14"/>
                        <path d="M12 12h6"/>
                        <path d="M12 12H6"/>
                        <path d="M12 9h4"/>
                        <path d="M12 9H8"/>
                        <path d="M12 15h4"/>
                        <path d="M12 15H8"/>
                      </svg>
                    </div>
                  </td>
                  <td style="vertical-align: middle; font-size: 20px; font-weight: bold; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                    NeuroSearch <span style="color: #00e5ff;">AI</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px; color: #f1f5f9;">
              <h2 style="font-size: 22px; font-weight: 700; color: #ffffff; margin-top: 0; margin-bottom: 20px;">
                ${title}
              </h2>
              <p style="font-size: 15px; line-height: 1.6; color: #94a3b8; margin-bottom: 30px;">
                ${description}
              </p>
              
              <!-- OTP Code Display -->
              <div style="background-color: #0b0f19; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 30px; border: 1px solid #1e293b;">
                <span style="font-size: 36px; font-weight: 800; color: #ffffff; font-family: 'Courier New', Courier, monospace; letter-spacing: 2px;">
                  ${spacedOtp}
                </span>
              </div>
              
              <p style="font-size: 14px; line-height: 1.5; color: #64748b; margin-bottom: 30px;">
                This code expires in 10 minutes. If you didn't request this, you can safely ignore this email — no account will be created.
              </p>
              
              <hr style="border: 0; border-top: 1px solid #1e293b; margin-bottom: 30px;" />
              
              <!-- Signature & Links -->
              <p style="font-size: 14px; color: #94a3b8; margin-bottom: 5px;">Warm regards,</p>
              <p style="font-size: 15px; font-weight: bold; color: #ffffff; margin-top: 0; margin-bottom: 15px;">Team NeuroSearch AI</p>
              
              <p style="font-size: 14px; color: #10b981; margin: 0;">
                <a href="mailto:rohit.paliwal@lifelancer.com" style="color: #10b981; text-decoration: none;">hello@neurosearch.com</a>
                <span style="color: #475569; padding: 0 8px;">|</span>
                <a href="https://neuro-frontend-two.vercel.app" style="color: #10b981; text-decoration: none;">NeuroSearch AI</a>
              </p>
            </td>
          </tr>
        </table>
        
        <!-- Footer Note -->
        <table width="100%" max-width="500" border="0" cellspacing="0" cellpadding="0" style="max-width: 500px; margin-top: 20px;">
          <tr>
            <td align="center" style="font-size: 12px; color: #475569;">
              This is an automated email from NeuroSearch AI Platform. Please do not reply.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      html,
    });
    logger.info(`OTP email sent to ${to} for purpose=${purpose}`);
  } catch (err) {
    logger.error(`Failed to send OTP email to ${to}: ${err.message}`);
    throw err;
  }
}

module.exports = { sendOtpEmail };
