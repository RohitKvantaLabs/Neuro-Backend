const mongoose = require('mongoose');
const Dataset = require('../dataset/dataset.model');
const DatasetReaction = require('../dataset/datasetReaction.model');
const { DatasetDislikeFeedback } = require('../dataset/datasetDislikeFeedback.model');
const { AdminDatasetOverride, ALLOWED_OVERRIDE_FIELDS } = require('../dataset/adminDatasetOverride.model');
const { PopularDataset } = require('../dataset/popularDataset.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const { logAdminAction } = require('../../utils/auditLog.util');

/**
 * Helper to find canonical dataset by Mongo _id or source_id
 */
async function findCanonicalDataset(datasetId) {
  if (!datasetId || typeof datasetId !== 'string') return null;
  const cleanId = datasetId.trim();

  let dataset = null;
  if (mongoose.Types.ObjectId.isValid(cleanId)) {
    dataset = await Dataset.findById(cleanId);
  }
  if (!dataset) {
    dataset = await Dataset.findOne({ source_id: cleanId });
  }
  if (!dataset) {
    dataset = await Dataset.findOne({ _id: cleanId });
  }
  return dataset;
}

/**
 * PATCH /api/v1/admin/datasets/:datasetId/override
 * Create or update metadata overrides for a dataset.
 */
const updateDatasetOverride = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  if (!datasetId) throw new ApiError(400, 'datasetId parameter is required.');

  const datasetDoc = await findCanonicalDataset(datasetId);
  if (!datasetDoc) throw new ApiError(404, 'Dataset not found.');

  const bodyKeys = Object.keys(req.body || {});
  const invalidKeys = bodyKeys.filter((key) => !ALLOWED_OVERRIDE_FIELDS.includes(key));
  if (invalidKeys.length > 0) {
    throw new ApiError(
      400,
      `Invalid override fields: ${invalidKeys.join(', ')}. Allowed fields: ${ALLOWED_OVERRIDE_FIELDS.join(', ')}`
    );
  }

  const updateData = {};
  ALLOWED_OVERRIDE_FIELDS.forEach((field) => {
    if (req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  });

  updateData.updatedBy = req.user.id;

  const overrideDoc = await AdminDatasetOverride.findOneAndUpdate(
    { datasetId: datasetId.trim() },
    { $set: updateData },
    { upsert: true, new: true, runValidators: true }
  );

  await logAdminAction(req.user.id, 'dataset.override.update', 'dataset', datasetId.trim(), {
    updatedFields: Object.keys(updateData).filter((k) => k !== 'updatedBy'),
  });

  return new ApiResponse(200, overrideDoc, 'Dataset override updated successfully.').send(res);
});

/**
 * DELETE /api/v1/admin/datasets/:datasetId/override
 * Revert metadata overrides for a dataset (returns dataset to canonical values).
 */
const deleteDatasetOverride = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  if (!datasetId) throw new ApiError(400, 'datasetId parameter is required.');

  const result = await AdminDatasetOverride.deleteOne({ datasetId: datasetId.trim() });
  if (result.deletedCount === 0) {
    throw new ApiError(404, 'No metadata override found for this dataset.');
  }

  await logAdminAction(req.user.id, 'dataset.override.revert', 'dataset', datasetId.trim(), {});

  return new ApiResponse(200, null, 'Dataset override reverted successfully.').send(res);
});

/**
 * POST /api/v1/admin/moderation/popular/:datasetId/publish
 * Explicitly publish a dataset into PopularDataset.
 */
const publishPopularDataset = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  const { displayOrder, featuredTitleOverride } = req.body || {};

  if (!datasetId) throw new ApiError(400, 'datasetId parameter is required.');

  const datasetDoc = await findCanonicalDataset(datasetId);
  if (!datasetDoc) throw new ApiError(404, 'Dataset not found.');
  if (datasetDoc.is_active === false) {
    throw new ApiError(400, 'Archived datasets cannot be published to Popular.');
  }

  const updateFields = {
    status: 'published',
    publishedBy: req.user.id,
    publishedAt: new Date(),
  };

  if (typeof displayOrder === 'number') {
    updateFields.displayOrder = displayOrder;
  }
  if (featuredTitleOverride !== undefined) {
    updateFields.featuredTitleOverride = featuredTitleOverride ? featuredTitleOverride.trim() : null;
  }

  const popularDoc = await PopularDataset.findOneAndUpdate(
    { datasetId: datasetId.trim() },
    { $set: updateFields },
    { upsert: true, new: true, runValidators: true }
  );

  await logAdminAction(req.user.id, 'dataset.publish', 'dataset', datasetId.trim(), {
    displayOrder: popularDoc.displayOrder,
    featuredTitleOverride: popularDoc.featuredTitleOverride,
  });

  return new ApiResponse(200, popularDoc, 'Dataset published to Popular successfully.').send(res);
});

/**
 * POST /api/v1/admin/moderation/popular/:datasetId/unpublish
 * Unpublish a dataset from PopularDataset (sets status to 'unpublished').
 */
const unpublishPopularDataset = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  if (!datasetId) throw new ApiError(400, 'datasetId parameter is required.');

  const popularDoc = await PopularDataset.findOne({ datasetId: datasetId.trim() });
  if (!popularDoc) throw new ApiError(404, 'Dataset is not in Popular catalog.');

  popularDoc.status = 'unpublished';
  await popularDoc.save();

  await logAdminAction(req.user.id, 'dataset.unpublish', 'dataset', datasetId.trim(), {});

  return new ApiResponse(200, popularDoc, 'Dataset unpublished successfully.').send(res);
});

/**
 * PUT /api/v1/admin/moderation/popular/reorder
 * Bulk update displayOrder for curated Popular datasets.
 */
const reorderPopularDatasets = asyncHandler(async (req, res) => {
  const { items } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'items array is required.');
  }

  const bulkOps = items
    .filter((item) => item?.datasetId && typeof item.displayOrder === 'number')
    .map((item) => ({
      updateOne: {
        filter: { datasetId: item.datasetId.trim() },
        update: { $set: { displayOrder: item.displayOrder } },
      },
    }));

  if (bulkOps.length === 0) {
    throw new ApiError(400, 'No valid items with datasetId and numeric displayOrder provided.');
  }

  await PopularDataset.bulkWrite(bulkOps);

  await logAdminAction(req.user.id, 'dataset.popular.reorder', 'dataset', null, {
    count: bulkOps.length,
  });

  return new ApiResponse(200, null, 'Popular datasets reordered successfully.').send(res);
});

/**
 * POST /api/v1/admin/datasets/:datasetId/archive
 * Stage 1 Safety Action: Archive dataset (is_active = false, PopularDataset status = archived).
 */
const archiveDataset = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  if (!datasetId) throw new ApiError(400, 'datasetId parameter is required.');

  const datasetDoc = await findCanonicalDataset(datasetId);
  if (!datasetDoc) throw new ApiError(404, 'Dataset not found.');

  datasetDoc.is_active = false;
  await datasetDoc.save();

  // If a PopularDataset entry exists, set status to 'archived'
  await PopularDataset.findOneAndUpdate(
    { datasetId: datasetId.trim() },
    { $set: { status: 'archived' } }
  );

  await logAdminAction(req.user.id, 'dataset.archive', 'dataset', datasetId.trim(), {
    title: datasetDoc.title,
  });

  return new ApiResponse(200, null, 'Dataset archived successfully.').send(res);
});

/**
 * POST /api/v1/admin/datasets/:datasetId/restore
 * Stage 1 Safety Action Reversal: Restore archived dataset (is_active = true).
 * PopularDataset status remains archived/unpublished to require explicit re-publish.
 */
const restoreDataset = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  if (!datasetId) throw new ApiError(400, 'datasetId parameter is required.');

  const datasetDoc = await findCanonicalDataset(datasetId);
  if (!datasetDoc) throw new ApiError(404, 'Dataset not found.');

  datasetDoc.is_active = true;
  await datasetDoc.save();

  await logAdminAction(req.user.id, 'dataset.restore', 'dataset', datasetId.trim(), {
    title: datasetDoc.title,
  });

  return new ApiResponse(200, null, 'Dataset restored successfully.').send(res);
});

/**
 * DELETE /api/v1/admin/datasets/:datasetId
 * Stage 2 Permanent Purge: Safely hard delete a dataset with explicit confirmation ID.
 * Uses a Mongoose transaction to atomically purge reactions, overrides, curation docs,
 * and mark feedback as resolved.
 */
const hardDeleteDataset = asyncHandler(async (req, res) => {
  const { datasetId } = req.params;
  const { confirmationId } = req.body || {};

  if (!datasetId) throw new ApiError(400, 'datasetId parameter is required.');

  const cleanId = datasetId.trim();
  if (!confirmationId || confirmationId.trim() !== cleanId) {
    throw new ApiError(400, 'confirmationId must match target datasetId exactly for permanent hard delete.');
  }

  const datasetDoc = await findCanonicalDataset(cleanId);

  // Attempt session/transaction with safe fallback for standalone Mongo or mock
  let session = null;
  if (mongoose.connection && mongoose.connection.readyState === 1 && typeof mongoose.startSession === 'function') {
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      session = null;
    }
  }

  const opts = session ? { session } : {};

  try {
    // 1. Delete canonical Dataset record (by _id or source_id)
    if (datasetDoc) {
      await Dataset.deleteOne({ _id: datasetDoc._id }, opts);
    } else {
      await Dataset.deleteOne({ source_id: cleanId }, opts);
    }

    // 2. Clean DatasetReaction documents
    await DatasetReaction.deleteMany({ datasetId: cleanId }, opts);

    // 3. Mark DatasetDislikeFeedback documents as resolved with admin notes
    await DatasetDislikeFeedback.updateMany(
      { datasetId: cleanId },
      {
        $set: {
          status: 'resolved',
          adminNotes: 'Dataset permanently deleted',
          resolvedAt: new Date(),
        },
      },
      opts
    );

    // 4. Remove AdminDatasetOverride
    await AdminDatasetOverride.deleteOne({ datasetId: cleanId }, opts);

    // 5. Remove PopularDataset
    await PopularDataset.deleteOne({ datasetId: cleanId }, opts);

    if (session) {
      await session.commitTransaction();
      session.endSession();
    }
  } catch (err) {
    if (session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }

  // 6. Write AuditLog entry
  await logAdminAction(req.user.id, 'dataset.delete_hard', 'dataset', cleanId, {
    title: datasetDoc?.title || 'Unknown dataset',
    source: datasetDoc?.source || 'unknown',
  });

  return new ApiResponse(200, null, 'Dataset permanently deleted successfully.').send(res);
});

module.exports = {
  updateDatasetOverride,
  deleteDatasetOverride,
  publishPopularDataset,
  unpublishPopularDataset,
  reorderPopularDatasets,
  archiveDataset,
  restoreDataset,
  hardDeleteDataset,
};
