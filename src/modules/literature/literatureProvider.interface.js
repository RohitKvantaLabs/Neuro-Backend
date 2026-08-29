'use strict';

/**
 * LiteratureProvider interface — implemented by scholarly + web adapters.
 * @interface
 */

class LiteratureProvider {
  /**
   * @param {Object} literatureQuery - from buildLiteratureQuery()
   * @param {Object} options - { limit: number }
   * @returns {Promise<Object[]>} - raw provider results (not yet normalized)
   */
  async search(literatureQuery, options = {}) {
    throw new Error('LiteratureProvider.search must be implemented');
  }

  get name() {
    return this.constructor.name;
  }
}

module.exports = { LiteratureProvider };
