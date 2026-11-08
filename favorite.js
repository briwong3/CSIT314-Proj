
class FavoritesController {
    constructor(db) {
        this.db = db;
    }

    async add(projectId, userId) {
        const { error } = await this.db
            .from('favorites')
            .insert({
                project_id: projectId,
                user_id: userId
            });

        if (error && error.code !== '23505') {
            throw error;
        }
    }

    async remove(projectId, userId) {
        const { error } = await this.db
            .from('favorites')
            .delete()
            .eq('project_id', projectId)
            .eq('user_id', userId);

        if (error) {
            throw error;
        }
    }
}

module.exports = FavoritesController;
