class CompanyController {
    constructor(db) {
        this.db = db;
    }

    // Retrieve company information for editing
    async companyForEdit(designerId) {
        const [profile, company, categories] = await Promise.all([
            this.db.from('profiles')
                .select('id,name')
                .eq('id', designerId)
                .single(),

            this.db.from('companies')
                .select('*')
                .eq('designer_id', designerId)
                .limit(1)
                .maybeSingle(),

            this.db.from('categories')
                .select('*')
                .order('name')
        ]);

        if (profile.error) throw profile.error;
        if (company.error) throw company.error;
        if (categories.error) throw categories.error;

        return {
            profile: profile.data,
            company: company.data,
            categories: categories.data
        };
    }

    // Save new or updated company information
    async saveCompany(designerId, fields, logoFile = null, coverFile = null) {
        const { data: existing, error } = await this.db
            .from('companies')
            .select('id,logo_url,cover_url')
            .eq('designer_id', designerId)
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        const uploadedUrls = [];

        let logoUrl;
        let coverUrl;

        try {
            logoUrl = await this.uploadCompanyAsset(
                designerId,
                'logo',
                logoFile
            );

            if (logoUrl) uploadedUrls.push(logoUrl);

            coverUrl = await this.uploadCompanyAsset(
                designerId,
                'cover',
                coverFile
            );

            if (coverUrl) uploadedUrls.push(coverUrl);

            const values = {
                ...fields,
                ...(logoUrl ? { logo_url: logoUrl } : {}),
                ...(coverUrl ? { cover_url: coverUrl } : {})
            };

            if (existing) {
                const result = await this.db
                    .from('companies')
                    .update(values)
                    .eq('id', existing.id)
                    .eq('designer_id', designerId)
                    .select('id')
                    .single();

                if (result.error) throw result.error;
            } else {
                const result = await this.db
                    .from('companies')
                    .insert({
                        designer_id: designerId,
                        ...values
                    })
                    .select('id')
                    .single();

                if (result.error) throw result.error;
            }

        } catch (error) {
            const cleanupWarnings = [];

            for (const imageUrl of uploadedUrls) {
                try {
                    const warning = await this.removeProjectImage(imageUrl);

                    if (warning) cleanupWarnings.push(warning);

                } catch (cleanupError) {
                    cleanupWarnings.push(
                        `An uploaded image could not be cleaned up: ${cleanupError.message}`
                    );
                }
            }

            if (cleanupWarnings.length) {
                throw new Error(
                    `${error.message} ${cleanupWarnings.join(' ')}`
                );
            }

            throw error;
        }

        // Remove previous logo and cover images if replaced
        const cleanupWarnings = [];

        for (const oldUrl of [
            logoUrl && existing?.logo_url,
            coverUrl && existing?.cover_url
        ]) {
            if (!oldUrl) continue;

            try {
                const warning = await this.removeProjectImage(oldUrl);

                if (warning) cleanupWarnings.push(warning);

            } catch (error) {
                cleanupWarnings.push(
                    `A replaced image could not be removed: ${error.message}`
                );
            }
        }

        return cleanupWarnings.length
            ? `Company information was saved, but an old image could not be removed. ${cleanupWarnings.join(' ')}`
            : null;
    }

    // Upload company logo or cover image
    async uploadCompanyAsset(designerId, kind, file) {
        if (!file) return null;

        const safeName = file.name.replace(
            /[^a-zA-Z0-9._-]/g,
            '_'
        );

        const path = `companies/${designerId}/${kind}-${Date.now()}-${safeName}`;

        const { error } = await this.db.storage
            .from('project-images')
            .upload(path, file, {
                cacheControl: '3600',
                upsert: false,
                contentType: file.type || 'application/octet-stream'
            });

        if (error) throw error;

        return this.db.storage
            .from('project-images')
            .getPublicUrl(path).data.publicUrl;
    }

    // Remove an old company image
    async removeProjectImage(imageUrl) {
        if (!imageUrl) return null;

        const marker = '/storage/v1/object/public/project-images/';
        const index = imageUrl.indexOf(marker);

        if (index < 0) return null;

        const path = decodeURIComponent(
            imageUrl.slice(index + marker.length)
        );

        const { error } = await this.db.storage
            .from('project-images')
            .remove([path]);

        return error
            ? `The project image could not be removed: ${error.message}`
            : null;
    }
}

module.exports = CompanyController;