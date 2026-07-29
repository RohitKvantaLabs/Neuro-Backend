const Announcement = require('./announcement.model');
const ApiError = require('../../utils/ApiError');
const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const { logAdminAction } = require('../../utils/auditLog.util');

// GET /announcements — Public endpoint to list active system broadcasts
const listActiveAnnouncements = asyncHandler(async (req, res) => {
  const items = await Announcement.find({ active: true })
    .sort({ created_at: -1 })
    .lean();

  const formatted = items.map((item) => ({
    id: item._id.toString(),
    title: item.title,
    body: item.body,
    active: item.active,
    created_at: item.created_at,
  }));

  return new ApiResponse(200, formatted, 'Active announcements fetched.').send(res);
});

// GET /admin/announcements — Admin endpoint to list all announcements (active & inactive)
const listAllAnnouncements = asyncHandler(async (req, res) => {
  const items = await Announcement.find()
    .sort({ created_at: -1 })
    .lean();

  const formatted = items.map((item) => ({
    id: item._id.toString(),
    title: item.title,
    body: item.body,
    active: item.active,
    created_at: item.created_at,
  }));

  return new ApiResponse(200, formatted, 'All announcements fetched.').send(res);
});

// POST /admin/announcements — Admin endpoint to compose and publish an announcement
const createAnnouncement = asyncHandler(async (req, res) => {
  const { title, body, active } = req.body;

  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new ApiError(400, 'Title is required.');
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    throw new ApiError(400, 'Body is required.');
  }

  const announcement = await Announcement.create({
    title: title.trim(),
    body: body.trim(),
    active: active !== undefined ? Boolean(active) : true,
    created_by: req.user?.id || null,
  });

  logAdminAction(req.user.id, 'announcement.create', 'announcement', announcement._id.toString(), { title: announcement.title });

  const formatted = {
    id: announcement._id.toString(),
    title: announcement.title,
    body: announcement.body,
    active: announcement.active,
    created_at: announcement.created_at,
  };

  return new ApiResponse(201, formatted, 'Announcement published successfully.').send(res);
});

// PATCH /admin/announcements/:id — Admin endpoint to edit an announcement
const updateAnnouncement = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, body, active } = req.body;

  const announcement = await Announcement.findById(id);
  if (!announcement) {
    throw new ApiError(404, 'Announcement not found.');
  }

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      throw new ApiError(400, 'Title cannot be empty.');
    }
    announcement.title = title.trim();
  }

  if (body !== undefined) {
    if (typeof body !== 'string' || !body.trim()) {
      throw new ApiError(400, 'Body cannot be empty.');
    }
    announcement.body = body.trim();
  }

  if (active !== undefined) {
    announcement.active = Boolean(active);
  }

  await announcement.save();

  logAdminAction(req.user.id, 'announcement.update', 'announcement', id, { title: title ? title.trim() : announcement.title });

  const formatted = {
    id: announcement._id.toString(),
    title: announcement.title,
    body: announcement.body,
    active: announcement.active,
    created_at: announcement.created_at,
  };

  return new ApiResponse(200, formatted, 'Announcement updated.').send(res);
});

// PATCH /admin/announcements/:id/toggle — Admin endpoint to toggle active state
const toggleAnnouncement = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;

  const announcement = await Announcement.findById(id);
  if (!announcement) {
    throw new ApiError(404, 'Announcement not found.');
  }

  announcement.active = active !== undefined ? Boolean(active) : !announcement.active;
  await announcement.save();

  logAdminAction(req.user.id, 'announcement.toggle', 'announcement', id, { active: announcement.active });

  const formatted = {
    id: announcement._id.toString(),
    title: announcement.title,
    body: announcement.body,
    active: announcement.active,
    created_at: announcement.created_at,
  };

  return new ApiResponse(200, formatted, 'Announcement status updated.').send(res);
});

// DELETE /admin/announcements/:id — Admin endpoint to delete an announcement
const deleteAnnouncement = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const announcement = await Announcement.findByIdAndDelete(id);
  if (!announcement) {
    throw new ApiError(404, 'Announcement not found.');
  }

  logAdminAction(req.user.id, 'announcement.delete', 'announcement', id, { title: announcement.title });

  return new ApiResponse(200, null, 'Announcement deleted.').send(res);
});

module.exports = {
  listActiveAnnouncements,
  listAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  toggleAnnouncement,
  deleteAnnouncement,
};
