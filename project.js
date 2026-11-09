(function (root, factory) {
  const ProjectController = factory();
  if (typeof module === 'object' && module.exports) module.exports = ProjectController;
  else root.ProjectController = ProjectController;
})(globalThis, function () {
  const must = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  return class ProjectController {
    constructor(db) {
      this.db = db;
    }

    async uploadProjectImage(designerId, imageFile) {
      const safeName = imageFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `projects/${designerId}/${Date.now()}-${safeName}`;
      const { error } = await this.db.storage.from('project-images').upload(path, imageFile, {
        cacheControl: '3600',
        upsert: false,
        contentType: imageFile.type || 'application/octet-stream'
      });
      if (error) throw error;
      return this.db.storage.from('project-images').getPublicUrl(path).data.publicUrl;
    }

    async removeProjectImage(imageUrl) {
      if (!imageUrl) return null;
      const marker = '/storage/v1/object/public/project-images/';
      const index = imageUrl.indexOf(marker);
      if (index < 0) return null;
      const path = decodeURIComponent(imageUrl.slice(index + marker.length));
      const { error } = await this.db.storage.from('project-images').remove([path]);
      return error ? `The project image could not be removed: ${error.message}` : null;
    }

    async createProject(fields, imageFile = null) {
      let imageUrl = null;
      if (imageFile) imageUrl = await this.uploadProjectImage(fields.designer_id, imageFile);

      return must(await this.db.from('projects').insert({
        designer_id: fields.designer_id,
        title: fields.title,
        description: fields.description || null,
        category_id: fields.category_id || null,
        budget: fields.budget === '' || fields.budget == null ? null : Number(fields.budget),
        stage: fields.stage || 'completed',
        progress: fields.progress == null ? 100 : Number(fields.progress),
        visibility: fields.visibility || 'published',
        ...(imageUrl ? { image_url: imageUrl } : {})
      }).select().single());
    }

    async editProject(id, designerId) {
      const [project, draft] = await Promise.all([
        this.db.from('projects').select('*').eq('id', id).eq('designer_id', designerId).single(),
        this.db.from('project_drafts').select('*').eq('project_id', id).eq('designer_id', designerId).maybeSingle()
      ]);
      const projectRow = must(project);
      const draftRow = must(draft);
      return {
        project: { ...projectRow, ...(draftRow ?? {}) },
        draft: draftRow
      };
    }

    saveProjectDraft(projectId, designerId, fields) {
      return this.db.from('project_drafts').upsert({
        project_id: projectId,
        designer_id: designerId,
        ...fields,
        updated_at: new Date().toISOString()
      }, { onConflict: 'project_id' }).then(must);
    }

    async saveProjectChanges(projectId, designerId, fields, imageFile = null) {
      const project = must(await this.db.from('projects')
        .select('image_url')
        .eq('id', projectId)
        .eq('designer_id', designerId)
        .single());
      const imageUrl = imageFile ? await this.uploadProjectImage(designerId, imageFile) : null;
      const update = await this.db.from('projects').update({
        ...fields,
        ...(imageUrl ? { image_url: imageUrl } : {})
      }).eq('id', projectId).eq('designer_id', designerId);
      if (update.error) {
        if (imageUrl) {
          try {
            const cleanupWarning = await this.removeProjectImage(imageUrl);
            if (cleanupWarning) throw new Error(cleanupWarning);
          } catch (cleanupError) {
            throw new Error(`${update.error.message} The uploaded replacement image could not be cleaned up: ${cleanupError.message}`);
          }
        }
        throw update.error;
      }

      const draftDelete = await this.db.from('project_drafts')
        .delete()
        .eq('project_id', projectId)
        .eq('designer_id', designerId);
      if (draftDelete.error) {
        throw new Error(`Project changes were saved, but the saved draft could not be cleared: ${draftDelete.error.message}`);
      }

      if (!imageUrl) return null;
      try {
        return await this.removeProjectImage(project.image_url);
      } catch (error) {
        return `Project changes were saved, but the previous image could not be removed: ${error.message}`;
      }
    }
  };
});
