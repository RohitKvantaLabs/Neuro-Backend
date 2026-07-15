const dns = require('dns').promises;
const disposableDomains = require('disposable-email-domains');

// ponytail: three-layer validation — regex, disposable blocklist, MX — cheap to expensive
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function validateEmail(email) {
  if (!EMAIL_RE.test(email)) return { valid: false, reason: 'Invalid email format.' };

  const domain = email.split('@')[1].toLowerCase();
  if (disposableDomains.includes(domain)) return { valid: false, reason: 'Disposable email addresses are not allowed.' };

  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return { valid: false, reason: 'Email domain has no mail server.' };
  } catch {
    return { valid: false, reason: 'Email domain has no mail server.' };
  }

  return { valid: true };
}

module.exports = { validateEmail };
