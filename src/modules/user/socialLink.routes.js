const express = require('express');
const { upsertSocialLink, listSocialLinks, deleteSocialLink } = require('./socialLink.controller');

const router = express.Router();

router.put('/', upsertSocialLink);
router.get('/', listSocialLinks);
router.delete('/:id', deleteSocialLink);

module.exports = router;
