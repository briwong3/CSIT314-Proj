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

(function (root) {
  const unwrap = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  class ProjectCategory {
    constructor(db) { this.db = db; }

    async categoryExists(name) {
      const rows = unwrap(await this.db.from('categories').select('id').eq('name', name).limit(1));
      return rows.length > 0;
    }

    async saveCategory(name, description = null) {
      try {
        unwrap(await this.db.from('categories').insert({ name, description }));
        return true;
      } catch (error) {
        if (error.code === '23505') throw new Error('Category already exists');
        throw error;
      }
    }

    async isCategoryUsed(categoryID) {
      const rows = unwrap(await this.db.rpc('platform_category_usage', {
        p_category_id: Number(categoryID)
      }));
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Category not found');
      const projects = Number(rows[0].project_count);
      const drafts = Number(rows[0].draft_count);
      if (!Number.isSafeInteger(projects) || !Number.isSafeInteger(drafts) || projects < 0 || drafts < 0) {
        throw new Error('Category usage information is invalid');
      }
      return projects + drafts > 0;
    }

    async removeCategory(categoryID) {
      const { error } = await this.db.rpc('platform_move_and_delete_category', {
        p_category_id: Number(categoryID), p_target_category_id: null
      });
      if (error) {
        if (error.code === '23503') throw new Error('Category currently in use');
        throw error;
      }
      return true;
    }
  }

  class CreateCategoryController {
    constructor(projectCategory) { this.projectCategory = projectCategory; }
    validateInput(name) { return typeof name === 'string' && name.trim().length > 0; }
    async createCategory(name, description = null) {
      if (!this.validateInput(name)) throw new Error('Category name is empty');
      const cleanName = name.trim();
      if (await this.projectCategory.categoryExists(cleanName)) {
        throw new Error('Category already exists');
      }
      return this.projectCategory.saveCategory(cleanName, description);
    }
  }

  class DeleteCategoryController {
    constructor(projectCategory) { this.projectCategory = projectCategory; }
    async validateCategory(categoryID) {
      if (!Number.isSafeInteger(Number(categoryID)) || Number(categoryID) <= 0) {
        throw new Error('Invalid category ID');
      }
      return !(await this.projectCategory.isCategoryUsed(categoryID));
    }
    async deleteCategory(categoryID) {
      if (!(await this.validateCategory(categoryID))) {
        throw new Error('Category currently in use');
      }
      return this.projectCategory.removeCategory(categoryID);
    }
  }

  class CreateCategoryUI {
    constructor({ dialog, form, controller, refresh, status }) {
      Object.assign(this, { dialog, form, controller, refresh, status });
    }
    displayCategories() { return this.refresh(); }
    selectCreateCategory() { this.displayCreateForm(); }
    displayCreateForm() {
      this.form.reset();
      this.form.elements.namedItem('id').value = '';
      this.dialog.querySelector('.category-modal-error').textContent = '';
      this.dialog.querySelector('#category-dialog-title').textContent = 'Add category';
      this.dialog.querySelector('#save-category').textContent = 'Add category';
      this.dialog.querySelector('#category-modal-note').textContent = 'This category will be available when customers search for projects.';
      this.dialog.showModal();
      this.form.elements.namedItem('name').focus();
    }
    async submitCategory(name, description = null) {
      try {
        await this.controller.createCategory(name, description);
        this.dialog.close();
        await this.displayCategories();
        this.displayMessage('Category created');
      } catch (error) { this.displayError(error.message); }
    }
    displayMessage(message) { this.status('success', message); }
    displayError(message) {
      this.dialog.querySelector('.category-modal-error').textContent = message;
      this.status('error', message);
    }
  }

  class DeleteCategoryUI {
    constructor({ dialog, controller, projectCategory, refresh, status }) {
      Object.assign(this, { dialog, controller, projectCategory, refresh, status });
      this.selectedCategoryID = null;
      this.requestId = 0;
      this.validated = false;
    }
    displayCategories() { return this.refresh(); }
    selectDeleteCategory(categoryID, categoryName) {
      return this.selectDeleteOption(categoryID, categoryName);
    }
    async selectDeleteOption(categoryID, categoryName) {
      this.selectedCategoryID = categoryID;
      this.validated = false;
      const request = ++this.requestId;
      this.dialog.querySelector('#category-delete-title').textContent = `Delete “${categoryName}”?`;
      this.dialog.querySelector('#category-delete-copy').textContent = 'Checking category usage…';
      this.dialog.querySelector('.category-delete-error').textContent = '';
      this.dialog.querySelector('#confirm-category-delete').disabled = true;
      this.requestConfirmation();
      try {
        const used = await this.projectCategory.isCategoryUsed(categoryID);
        if (request !== this.requestId || !this.dialog.open) return;
        this.validated = !used;
        if (used) {
          this.dialog.querySelector('#category-delete-copy').textContent = 'This category is used by projects or saved drafts and cannot be deleted.';
          this.displayError('Category currently in use');
        } else {
          this.dialog.querySelector('#category-delete-copy').textContent = 'No projects or saved drafts use this category. This cannot be undone.';
          this.dialog.querySelector('#confirm-category-delete').disabled = false;
        }
      } catch (error) {
        if (request !== this.requestId || !this.dialog.open) return;
        this.dialog.querySelector('#category-delete-copy').textContent = 'Category usage could not be checked. Try again.';
        this.displayError(error.message);
      }
    }
    requestConfirmation() { this.dialog.showModal(); }
    async confirmDeletion(categoryID = this.selectedCategoryID) {
      if (!this.validated || categoryID == null) {
        this.displayError('Category usage has not been checked');
        return;
      }
      const button = this.dialog.querySelector('#confirm-category-delete');
      button.disabled = true;
      try {
        await this.controller.deleteCategory(categoryID);
        this.dialog.close();
        await this.returnToCategoryManagement();
        this.displayMessage('Category deleted');
      } catch (error) {
        this.displayError(error.message);
        if (error.message !== 'Category currently in use') button.disabled = false;
      }
    }
    cancelDeletion() {
      this.requestId++;
      this.selectedCategoryID = null;
      this.validated = false;
      this.dialog.close();
      return this.returnToCategoryManagement();
    }
    displayMessage(message) { this.status('success', message); }
    displayError(message) {
      this.dialog.querySelector('.category-delete-error').textContent = message;
      this.status('error', message);
    }
    returnToCategoryManagement() { return this.displayCategories(); }
  }

  root.ProjectCategory = ProjectCategory;
  root.CreateCategoryController = CreateCategoryController;
  root.DeleteCategoryController = DeleteCategoryController;
  root.CreateCategoryUI = CreateCategoryUI;
  root.DeleteCategoryUI = DeleteCategoryUI;
  if (typeof module === 'object' && module.exports) {
    Object.assign(module.exports, {
      ProjectCategory, CreateCategoryController, DeleteCategoryController,
      CreateCategoryUI, DeleteCategoryUI
    });
  }
})(globalThis);
