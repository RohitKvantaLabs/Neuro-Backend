const SocialLink = require('./socialLink.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');

const VALID_PLATFORMS = ['linkedin', 'github', 'pinterest', 'instagram'];

// PUT /users/social-links — upsert one (matches frontend's onConflict: 'user_id,platform')
const upsertSocialLink = asyncHandler(async (req, res) => {
  const { platform, url } = req.body;
  if (!platform || !VALID_PLATFORMS.includes(platform)) throw new ApiError(400, `platform must be one of: ${VALID_PLATFORMS.join(', ')}.`);
  if (!url) throw new ApiError(400, 'url is required.');

  // Basic URL validation — ponytail: native URL constructor is enough here
  try { new URL(url); } catch { throw new ApiError(400, 'url must be a valid URL.'); }

  const link = await SocialLink.findOneAndUpdate(
    { userId: req.user.id, platform },
    { url },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return new ApiResponse(200, link, 'Social link saved.').send(res);
});

// GET /users/social-links
const listSocialLinks = asyncHandler(async (req, res) => {
  const links = await SocialLink.find({ userId: req.user.id }).lean();
  return new ApiResponse(200, links).send(res);
});

// DELETE /users/social-links/:id
const deleteSocialLink = asyncHandler(async (req, res) => {
  const doc = await SocialLink.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!doc) throw new ApiError(404, 'Social link not found.');
  return new ApiResponse(200, null, 'Social link deleted.').send(res);
});

module.exports = { upsertSocialLink, listSocialLinks, deleteSocialLink };
