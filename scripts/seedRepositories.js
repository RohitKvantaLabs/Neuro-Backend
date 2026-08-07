// ponytail: one-shot seed — mirrors seedAdmin.js pattern
require('dotenv').config();
const mongoose = require('mongoose');
const Repository = require('../src/modules/admin/repository.model');

const REPOS = [
  { name: 'OpenNeuro',        trust_tier: 'open',       dataset_count: 1848, endpoint_config: { url: 'https://openneuro.org/' } },
  { name: 'DANDI Archive',    trust_tier: 'open',       dataset_count: 1153, endpoint_config: { url: 'https://dandiarchive.org/' } },
  { name: 'NITRC',            trust_tier: 'open',       dataset_count: 431,  endpoint_config: { url: 'https://www.nitrc.org/' } },
  { name: 'NEMAR',            trust_tier: 'open',       dataset_count: 754,  endpoint_config: { url: 'https://nemar.org/' } },
  { name: 'Allen Brain Atlas',trust_tier: 'open',       dataset_count: 172,  endpoint_config: { url: 'https://brain-map.org/atlases' } },
  { name: 'Human Connectome', trust_tier: 'registered', dataset_count: 96,   endpoint_config: { url: 'https://www.humanconnectome.org/' } },
  { name: 'ADNI',             trust_tier: 'restricted', dataset_count: 74,   endpoint_config: { url: 'https://adni.loni.usc.edu/' } },
  { name: 'EBRAINS',          trust_tier: 'open',       dataset_count: 1148, endpoint_config: { url: 'https://ebrains.eu/data-tools-services/data-knowledge/find-data' } },
  { name: 'UK Biobank',       trust_tier: 'restricted', dataset_count: 218,  endpoint_config: { url: 'https://www.ukbiobank.ac.uk/projects/analysis-of-biobank-neuro-imaging-data/' } },
  { name: 'NeuroMorpho',      trust_tier: 'open',       dataset_count: 1011, endpoint_config: { url: 'https://neuromorpho.org/' } },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  let updatedCount = 0;

  for (const r of REPOS) {
    await Repository.findOneAndUpdate(
      { name: r.name },
      {
        $set: {
          dataset_count: r.dataset_count,
          trust_tier: r.trust_tier,
          endpoint_config: r.endpoint_config,
          sync_status: 'online',
          last_sync_at: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    updatedCount++;
    console.log(`  ✓ Updated/Seeded: ${r.name} (${r.dataset_count} datasets)`);
  }

  console.log(`\nDone — ${updatedCount} repositories seeded/updated.`);
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
