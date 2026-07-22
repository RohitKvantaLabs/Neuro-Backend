const Collection = require('./collection.model');
const CollectionItem = require('./collectionItem.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');

// §10.4: One reusable helper — write once, don't repeat inline
async function assertOwnsCollection(collectionId, userId) {
  const col = await Collection.findOne({ _id: collectionId, userId });
  if (!col) throw new ApiError(404, 'Collection not found.');
  return col;
}

// POST /users/collections
const createCollection = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Collection name is required.');
  const col = await Collection.create({ userId: req.user.id, name: name.trim() });
  return new ApiResponse(201, col, 'Collection created.').send(res);
});

// GET /users/collections (includes item counts via $lookup)
const listCollections = asyncHandler(async (req, res) => {
  const cols = await Collection.aggregate([
    { $match: { userId: require('mongoose').Types.ObjectId.createFromHexString(req.user.id) } },
    { $lookup: { from: 'collectionitems', localField: '_id', foreignField: 'collectionId', as: 'items' } },
    { $addFields: { itemCount: { $size: '$items' } } },
    { $project: { items: 0 } },
    { $sort: { createdAt: -1 } },
  ]);
  return new ApiResponse(200, cols).send(res);
});

// DELETE /users/collections/:id (cascade deletes items)
const deleteCollection = asyncHandler(async (req, res) => {
  const col = await assertOwnsCollection(req.params.id, req.user.id);
  await Promise.all([
    CollectionItem.deleteMany({ collectionId: col._id }),
    Collection.findByIdAndDelete(col._id),
  ]);
  return new ApiResponse(200, null, 'Collection deleted.').send(res);
});

// POST /users/collections/:id/items
const addItem = asyncHandler(async (req, res) => {
  const col = await assertOwnsCollection(req.params.id, req.user.id);
  const { savedDatasetId } = req.body;
  if (!savedDatasetId) throw new ApiError(400, 'savedDatasetId is required.');

  // upsert — duplicate is silently ignored
  const item = await CollectionItem.findOneAndUpdate(
    { collectionId: col._id, savedDatasetId },
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return new ApiResponse(201, item, 'Item added to collection.').send(res);
});

// DELETE /users/collections/:id/items/:savedDatasetId
const removeItem = asyncHandler(async (req, res) => {
  const col = await assertOwnsCollection(req.params.id, req.user.id);
  const deleted = await CollectionItem.findOneAndDelete({ collectionId: col._id, savedDatasetId: req.params.savedDatasetId });
  if (!deleted) throw new ApiError(404, 'Item not found in collection.');
  return new ApiResponse(200, null, 'Item removed from collection.').send(res);
});

// GET /users/collections/:id/items — list items in a collection with snapshot data
const getItems = asyncHandler(async (req, res) => {
  const col = await assertOwnsCollection(req.params.id, req.user.id);
  const items = await CollectionItem.find({ collectionId: col._id })
    .populate('savedDatasetId')
    .sort({ createdAt: -1 })
    .lean();
  return new ApiResponse(200, items).send(res);
});

module.exports = { createCollection, listCollections, deleteCollection, addItem, removeItem, getItems };
