(function (root, factory) {
  const CategoryController = factory();
  if (typeof module === 'object' && module.exports) module.exports = CategoryController;
  else root.CategoryController = CategoryController;
})(globalThis, function () {
  const must = ({ data, error }) => {
    if (error) throw error;
    return data;
  };
  const loadAllRows = async createQuery => {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const batch = must(await createQuery().range(offset, offset + 999));
      rows.push(...batch);
      if (batch.length < 1000) return rows;
    }
  };

  return class CategoryController {
    constructor(db) {
      this.db = db;
    }

    async categories() {
      return must(await this.db.from('categories').select('*').order('name'));
    }

    async categoryStats() {
      const [categories, projects] = await Promise.all([
        loadAllRows(() => this.db.from('categories').select('*').order('id')),
        loadAllRows(() => this.db.from('projects').select('category_id,views').eq('visibility', 'published').order('id'))
      ]);
      const stats = new Map();
      for (const project of projects) {
        const current = stats.get(project.category_id) ?? { projects: 0, views: 0 };
        current.projects += 1;
        current.views += project.views ?? 0;
        stats.set(project.category_id, current);
      }
      return categories.map(category => ({
        ...category,
        projects: stats.get(category.id)?.projects ?? 0,
        views: stats.get(category.id)?.views ?? 0
      }));
    }

    createCategory(fields) {
      return this.db.from('categories').insert(fields).then(must);
    }

    updateCategory(id, fields) {
      return this.db.from('categories').update(fields).eq('id', id).then(must);
    }

    async categoryUsage(id) {
      return must(await this.db.rpc('platform_category_usage', { p_category_id: Number(id) }));
    }

    async moveAndDeleteCategory(id, targetId) {
      return must(await this.db.rpc('platform_move_and_delete_category', {
        p_category_id: Number(id),
        p_target_category_id: targetId == null ? null : Number(targetId)
      }));
    }
  };
});
