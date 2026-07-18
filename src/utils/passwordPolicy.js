/**
 * Shared password policy for user registration/reset and admin CLI scripts.
 *
 * Rules (8-15 characters):
 *   - At least one uppercase letter  [A-Z]
 *   - At least one digit             [0-9]
 *   - At least one special character [^A-Za-z0-9]
 *
 * The character class in the original spec ([A-Za-z0-9^A-Za-z0-9]) was
 * redundant; the lookaheads alone enforce composition — the overall length
 * is the only remaining constraint, so we use `.{8,15}`.
 */

const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,15}$/;

const PASSWORD_MESSAGE =
  'Password must be 8–15 characters and include at least one uppercase letter, one number, and one special character.';

/**
 * Returns true if the plain-text password satisfies the policy.
 * @param {string} password
 * @returns {boolean}
 */
function isValidPassword(password) {
  return PASSWORD_REGEX.test(password);
}

module.exports = { PASSWORD_REGEX, PASSWORD_MESSAGE, isValidPassword };
