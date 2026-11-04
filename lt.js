
//get the existing project and photos
async editProject(id, designerId, fields) {
    const project = must(await db.from('projects')
    .select('*').eq('id', id).eq('designer_id', designerId)
    .single());
    const photos = must(await db.from('project_photos').select('id,url,position,is_cover').eq('project_id', id).order('position'));
  return { project, photos };
}

// Change project cover photo
async setProjectCoverPhoto(projectId, designerId, photoId) {
    must(await db.from('project_photos')
        .update({ is_cover: false })
        .eq('project_id', projectId));

    must(await db.from('project_photos')
        .update({ is_cover: true })
        .eq('id', photoId)
        .eq('project_id', projectId));

    must(await db.from('projects')
        .update({ image_url: photo.url })
        .eq('id', projectId)
        .eq('designer_id', designerId));
    return true;
}

//display all the data needed to render the edit project page
async editProjectView(projectId) {
    const designerId = this.designerDashboardUserId;
    const projectData = await this.designers.editProject(projectId, designerId);
    const project = projectData.project;
    const photos = projectData.photos;
    const categories = await this.designers.categories();

    const categoryOptions = categories.map(category => `
        <option value="${category.id}"
            ${String(category.id) === String(project.category_id) ? 'selected' : ''}>
            ${esc(category.name)}
        </option>
    `).join('');

    const photolist = photos.map(photo => `
        <div class="edit-project-photo" data-photo-id="${photo.id}" data-is-cover="${photo.is_cover}">
        <img src="${esc(photo.url)}" alt="Project photo">
        ${photo.is_cover? '<span class="edit-project-cover-label">Cover photo</span>': 
            `<button type="button" class="set-cover-button">Set cover</button>`}
        </div>
    `).join('');

    //how the edit page looks like
    this.show(`
        <div class="edit-project-page">
        <div class="edit-project-heading">
        <div>
        <h1>Edit project</h1>
        <p>Update details, photos, stage or visibility.</p>
        </div>
        </div>
        <form id="edit-project-form">
        <section class="designer-projectDetails-edit-section">
        <h2>Project details</h2>
        <div class="edit-project-grid">
        <label>Project title<input
        type="text"
        name="title"
        maxlength="120"
        value="${esc(project.title ?? '')}"
        required>
        </label>

        <label>Category<select name="category_id">
        <option value="">Select a category</option>
        ${categoryOptions}
        </select>
        </label>

        <label>Budget range<input
        type="number"
        name="budget"
        min="0"
        step="100"
        value="${project.budget ?? ''}">
        </label>

        <label>Completion date<input
        type="date"
        name="completion_date"
        value="${project.completion_date ?? ''}">
        </label>
        </div>

        <label>Description<textarea
        name="description"
        rows="10"
        maxlength="2000">${esc(project.description ?? '')}</textarea>
        </label>
        </section>

        <section class="designer-projectPhotos-edit-panel">
        <h2>Photos</h2>

        <div class="edit-project-photos">
        ${photolist || '<p>No photos have been uploaded.</p>'}
        </div>
        </section>

        <section class="designer-projectStage-edit-panel">
        <h2>Project stage</h2>
        <label>
        <input 
        type="radio" 
        name="stage" 
        value="ongoing"
        ${project.stage === 'ongoing' ? 'checked' : ''}>
        Ongoing (work in progress)
        </label>

        <label>Progress (%)<input type = "number"
        name="progress" 
        min = "0"
        max="100"
        step="10"
        value="${project.stage === 'ongoing' ? project.progress : 0}">
        </label>

        <label>
        <input 
        type="radio" 
        name="stage" 
        value="completed"
        ${project.stage === 'completed' ? 'checked' : ''}>
        Completed (past project)
        </label>
        </section>

        <section class="designer-projectVisibility-edit-panel">
        <h2>Visibility</h2>

        <label>
        <input type="radio" name="visibility" value="draft"
        ${project.visibility === 'draft' ? 'checked' : ''}>
        Draft (only you can see it)
        </label>

        <label>
        <input type="radio" name="visibility" value="published"
        ${project.visibility !== 'draft' ? 'checked' : ''}>
        Published (visible to customers)
        </label>
        </section>
      
        <div class="project-edit-actions">
        <button type="button" class="btn secondary-btn"
        id="edit-project-cancel">Cancel</button>

        <button type="submit" class="btn secondary-btn"
        name="saveDraftMode" value="draft">Save as draft</button>

        <button type="submit" class="btn"
        name="saveMode" value="save">Save changes</button>
        </div>
        </form>
        </div>
    `);

    const form = this.$('#edit-project-form');

    //Cover pictures 
    this.$$('.edit-project-photo').forEach(photoEl => {
        const photoId = photoEl.dataset.photoId;
        const isCover = photoEl.dataset.isCover === 'true';    

        if (photoEl.dataset.isCover === 'false') {
            const button = photoEl.querySelector('.set-cover-button');
            if (button) {
                button.onclick = this.guard(async() => {
                    await this.designers.setProjectCoverPhoto(projectId, designerId, photoId);
                });
            }
        }
    });

    // Cancel function
    this.$('#edit-project-cancel').onclick = () => {
        this.designerDashboardView();
    };

    // Save project changes
form.onsubmit = this.guard(async event => {
    event.preventDefault();

    const data = Object.fromEntries(new FormData(form));

    const title = String(data.title ?? '').trim();
    const budget = data.budget === ''
        ? null
        : Number(data.budget);

    if (!title) {
        throw new Error('Project title is required.');
    }

    if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
        throw new Error('Please enter a valid budget.');
    }

    const fields = {
        title,
        description: String(data.description ?? '').trim() || null,
        category_id: data.category_id ? Number(data.category_id) : null,
        budget,
        completion_date: data.completion_date || null,
        stage: data.stage,
        visibility: data.visibility
    };

    // Save Draft
    if (event.submitter.value === 'draft') {
        const confirmed = window.confirm(
            'This will delete your previous exsiting draft for this project. Continue?'
        );

        if (!confirmed) {
            return;
        }

        await this.designers.saveProjectDraft(projectId, designerId, fields);
        return;
    }

    // Save Changes
    if (event.submitter.value === 'save') {
        await this.designers.saveProjectChanges(projectId, designerId, fields);
    }
});
}


