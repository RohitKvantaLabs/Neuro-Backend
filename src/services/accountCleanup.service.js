const { User } = require('../modules/user/user.model');
const Collection = require('../modules/user/collection.model');
const CollectionItem = require('../modules/user/collectionItem.model');
const SavedDataset = require('../modules/user/savedDataset.model');
const SearchHistory = require('../modules/user/searchHistory.model');
const SocialLink = require('../modules/user/socialLink.model');

/**
 * Permanently purges user accounts and associated data after the 30-day grace period expires.
 */
async function processScheduledDeletions() {
  try {
    const now = new Date();
    const expiredUsers = await User.find({
      isDeleted: true,
      scheduledDeletionAt: { $lte: now },
    }).select('_id email');

    if (!expiredUsers || expiredUsers.length === 0) {
      return { purgedCount: 0 };
    }

    let purgedCount = 0;
    for (const u of expiredUsers) {
      const userId = u._id;
      const collectionIds = await Collection.find({ userId }).distinct('_id');

      await Promise.all([
        User.findByIdAndDelete(userId),
        SavedDataset.deleteMany({ userId }),
        Collection.deleteMany({ userId }),
        CollectionItem.deleteMany({ collectionId: { $in: collectionIds } }),
        SearchHistory.deleteMany({ userId }),
        SocialLink.deleteMany({ userId }),
      ]);
      purgedCount++;
      console.log(`[AccountCleanupService] Permanently deleted user ${u.email} (${userId}) after 30-day grace period.`);
    }

    return { purgedCount };
  } catch (err) {
    console.error('[AccountCleanupService] Error running scheduled account cleanup:', err);
    return { error: err.message };
  }
}

/**
 * Starts a recurring interval timer for account deletion cleanup (every 24 hours).
 */
function startAccountCleanupScheduler(intervalMs = 24 * 60 * 60 * 1000) {
  // Run once immediately on server startup
  processScheduledDeletions().catch(() => {});
  // Schedule recurring interval
  const timer = setInterval(() => {
    processScheduledDeletions().catch(() => {});
  }, intervalMs);

  return timer;
}

module.exports = {
  processScheduledDeletions,
  startAccountCleanupScheduler,
};
