(function (root, factory) {
  const FavoritesController = factory();
  if (typeof module === 'object' && module.exports) module.exports = FavoritesController;
  else root.FavoritesController = FavoritesController;
})(globalThis, function () {
  const must = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  return class FavoritesController {
    constructor(db) {
      this.db = db;
    }

    async ids(userId) {
      return new Set(must(await this.db.from('favorites').select('project_id').eq('user_id', userId))
        .map(row => Number(row.project_id)));
    }

    async list() {
      const rows = must(await this.db.from('favorites')
        .select('created_at, project:projects!inner(*, categories(name))')
        .eq('project.visibility', 'published')
        .order('created_at', { ascending: false }));
      const projects = rows.map(row => row.project).filter(Boolean);
      const designerIds = [...new Set(projects.map(project => project.designer_id).filter(Boolean))];
      if (!designerIds.length) return projects;
      const profiles = must(await this.db.from('profiles').select('id,name').in('id', designerIds));
      const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
      return projects.map(project => ({
        ...project,
        profiles: profilesById.get(project.designer_id) ?? null
      }));
    }

    async add(projectId, userId) {
      const { error } = await this.db.from('favorites').insert({ project_id: projectId, user_id: userId });
      if (error && error.code !== '23505') throw error;
    }

    async remove(projectId, userId) {
      must(await this.db.from('favorites').delete().eq('project_id', projectId).eq('user_id', userId));
    }
  };
});
