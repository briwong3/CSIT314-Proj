
const CompanyController = require('../company');

//Retrieve Company Information
describe('Company Information - Retrieve Company', () => {
    let db;
    let controller;

    beforeEach(() => {
        db = {
            from: jest.fn()
        };

        controller = new CompanyController(db);
    });

    test('should retrieve company profile, company details and categories', async () => {
        const profileData = {
            id: 'designer-123',
            name: 'John Designer'
        };

        const companyData = {
            id: 1,
            designer_id: 'designer-123',
            name: 'Modern Design Studio'
        };

        const categoriesData = [
            { id: 1, name: 'Living Room' },
            { id: 2, name: 'Bedroom' }
        ];

        const profileQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: profileData,
                error: null
            })
        };

        const companyQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: companyData,
                error: null
            })
        };

        const categoriesQuery = {
            select: jest.fn().mockReturnThis(),
            order: jest.fn().mockResolvedValue({
                data: categoriesData,
                error: null
            })
        };

        db.from.mockImplementation((table) => {
            if (table === 'profiles') return profileQuery;
            if (table === 'companies') return companyQuery;
            if (table === 'categories') return categoriesQuery;
        });

        const result = await controller.companyForEdit('designer-123');

        expect(result.profile).toEqual(profileData);
        expect(result.company).toEqual(companyData);
        expect(result.categories).toEqual(categoriesData);
    });

    test('should return null when the designer has no company information', async () => {
        const profileQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: { id: 'designer-123', name: 'John Designer' },
                error: null
            })
        };

        const companyQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: null,
                error: null
            })
        };

        const categoriesQuery = {
            select: jest.fn().mockReturnThis(),
            order: jest.fn().mockResolvedValue({
                data: [],
                error: null
            })
        };

        db.from.mockImplementation((table) => {
            if (table === 'profiles') return profileQuery;
            if (table === 'companies') return companyQuery;
            if (table === 'categories') return categoriesQuery;
        });

        const result = await controller.companyForEdit('designer-123');

        expect(result.company).toBeNull();
        expect(result.categories).toEqual([]);
    });

    test('should return an error when retrieving company information fails', async () => {
        const databaseError = new Error('Unable to retrieve company information');

        const profileQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: { id: 'designer-123', name: 'John Designer' },
                error: null
            })
        };

        const companyQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: null,
                error: databaseError
            })
        };

        const categoriesQuery = {
            select: jest.fn().mockReturnThis(),
            order: jest.fn().mockResolvedValue({
                data: [],
                error: null
            })
        };

        db.from.mockImplementation((table) => {
            if (table === 'profiles') return profileQuery;
            if (table === 'companies') return companyQuery;
            if (table === 'categories') return categoriesQuery;
        });

        await expect(
            controller.companyForEdit('designer-123')
        ).rejects.toThrow('Unable to retrieve company information');
    });
});


//Save Company Information
describe('Company Information - Save Company', () => {
    let db;
    let controller;
    let existingQuery;

    beforeEach(() => {
        existingQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn()
        };

        db = {
            from: jest.fn()
        };

        controller = new CompanyController(db);
    });

    test('should create a new company successfully', async () => {
        existingQuery.maybeSingle.mockResolvedValue({
            data: null,
            error: null
        });

        const insertQuery = {
            insert: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: { id: 1 },
                error: null
            })
        };

        db.from.mockImplementation(() => {
            if (db.from.mock.calls.length === 1) {
                return existingQuery;
            }

            return insertQuery;
        });

        const result = await controller.saveCompany(
            'designer-123',
            {
                name: 'Modern Design Studio',
                tagline: 'Creating beautiful spaces'
            }
        );

        expect(insertQuery.insert).toHaveBeenCalledWith({
            designer_id: 'designer-123',
            name: 'Modern Design Studio',
            tagline: 'Creating beautiful spaces'
        });

        expect(result).toBeNull();
    });

    test('should update existing company information successfully', async () => {
        existingQuery.maybeSingle.mockResolvedValue({
            data: {
                id: 1,
                logo_url: null,
                cover_url: null
            },
            error: null
        });

        const updateQuery = {
            update: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: { id: 1 },
                error: null
            })
        };

        db.from.mockImplementation(() => {
            if (db.from.mock.calls.length === 1) {
                return existingQuery;
            }

            return updateQuery;
        });

        const result = await controller.saveCompany(
            'designer-123',
            {
                name: 'Updated Design Studio',
                tagline: 'Updated tagline'
            }
        );

        expect(updateQuery.update).toHaveBeenCalledWith({
            name: 'Updated Design Studio',
            tagline: 'Updated tagline'
        });

        expect(result).toBeNull();
    });

    test('should save company information without uploading images', async () => {
        existingQuery.maybeSingle.mockResolvedValue({
            data: null,
            error: null
        });

        const insertQuery = {
            insert: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: { id: 2 },
                error: null
            })
        };

        db.from.mockImplementation(() => {
            return db.from.mock.calls.length === 1
                ? existingQuery
                : insertQuery;
        });

        const result = await controller.saveCompany(
            'designer-123',
            {
                name: 'Simple Design Studio'
            },
            null,
            null
        );

        expect(insertQuery.insert).toHaveBeenCalledWith({
            designer_id: 'designer-123',
            name: 'Simple Design Studio'
        });

        expect(result).toBeNull();
    });

    test('should return an error when saving company information fails', async () => {
        const databaseError = new Error('Unable to save company information');

        existingQuery.maybeSingle.mockResolvedValue({
            data: null,
            error: null
        });

        const insertQuery = {
            insert: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: null,
                error: databaseError
            })
        };

        db.from.mockImplementation(() => {
            return db.from.mock.calls.length === 1
                ? existingQuery
                : insertQuery;
        });

        await expect(
            controller.saveCompany('designer-123', {
                name: 'Failed Design Studio'
            })
        ).rejects.toThrow('Unable to save company information');
    });
});


//Upload Company Logo and Cover
describe('Company Information - Upload Company Assets', () => {
    let db;
    let controller;

    beforeEach(() => {
        db = {
            storage: {
                from: jest.fn().mockReturnThis(),
                upload: jest.fn(),
                getPublicUrl: jest.fn()
            }
        };

        controller = new CompanyController(db);
    });

    test('should upload a company logo successfully', async () => {
        const logoFile = {
            name: 'company logo.png',
            type: 'image/png'
        };

        db.storage.upload.mockResolvedValue({
            error: null
        });

        db.storage.getPublicUrl.mockReturnValue({
            data: {
                publicUrl: 'https://example.com/company-logo.png'
            }
        });

        const result = await controller.uploadCompanyAsset(
            'designer-123',
            'logo',
            logoFile
        );

        expect(db.storage.from).toHaveBeenCalledWith('project-images');

        expect(db.storage.upload).toHaveBeenCalledWith(
            expect.stringMatching(/^companies\/designer-123\/logo-/),
            logoFile,
            expect.objectContaining({
                cacheControl: '3600',
                upsert: false,
                contentType: 'image/png'
            })
        );

        expect(result).toBe('https://example.com/company-logo.png');
    });

    test('should upload a company cover successfully', async () => {
        const coverFile = {
            name: 'company-cover.jpg',
            type: 'image/jpeg'
        };

        db.storage.upload.mockResolvedValue({
            error: null
        });

        db.storage.getPublicUrl.mockReturnValue({
            data: {
                publicUrl: 'https://example.com/company-cover.jpg'
            }
        });

        const result = await controller.uploadCompanyAsset(
            'designer-123',
            'cover',
            coverFile
        );

        expect(db.storage.upload).toHaveBeenCalledWith(
            expect.stringMatching(/^companies\/designer-123\/cover-/),
            coverFile,
            expect.objectContaining({
                contentType: 'image/jpeg'
            })
        );

        expect(result).toBe('https://example.com/company-cover.jpg');
    });

    test('should return null when no image is provided', async () => {
        const result = await controller.uploadCompanyAsset(
            'designer-123',
            'logo',
            null
        );

        expect(result).toBeNull();
        expect(db.storage.from).not.toHaveBeenCalled();
    });

    test('should return an error when image upload fails', async () => {
        const uploadError = new Error('Unable to upload company image');

        const logoFile = {
            name: 'company-logo.png',
            type: 'image/png'
        };

        db.storage.upload.mockResolvedValue({
            error: uploadError
        });

        await expect(
            controller.uploadCompanyAsset(
                'designer-123',
                'logo',
                logoFile
            )
        ).rejects.toThrow('Unable to upload company image');
    });
});


//Remove Company Images
describe('Company Information - Remove Company Images', () => {
    let db;
    let controller;
    let storageBucket;

    beforeEach(() => {
        storageBucket = {
            remove: jest.fn()
        };

        db = {
            storage: {
                from: jest.fn().mockReturnValue(storageBucket)
            }
        };

        controller = new CompanyController(db);
    });

    test('should remove an existing company image successfully', async () => {
        storageBucket.remove.mockResolvedValue({
            error: null
        });

        const imageUrl =
            'https://example.com/storage/v1/object/public/project-images/companies/designer-123/logo.png';

        const result = await controller.removeProjectImage(imageUrl);

        expect(db.storage.from).toHaveBeenCalledWith('project-images');

        expect(storageBucket.remove).toHaveBeenCalledWith([
            'companies/designer-123/logo.png'
        ]);

        expect(result).toBeNull();
    });

    test('should ignore an image URL outside the project-images bucket', async () => {
        const imageUrl = 'https://example.com/images/logo.png';

        const result = await controller.removeProjectImage(imageUrl);

        expect(db.storage.from).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });

    test('should return an error message when image removal fails', async () => {
        storageBucket.remove.mockResolvedValue({
            error: {
                message: 'Storage deletion failed'
            }
        });

        const imageUrl =
            'https://example.com/storage/v1/object/public/project-images/companies/designer-123/logo.png';

        const result = await controller.removeProjectImage(imageUrl);

        expect(result).toBe(
            'The project image could not be removed: Storage deletion failed'
        );
    });
});


//Replace Company Images
describe('Company Information - Replace Company Images', () => {
    let db;
    let controller;
    let storageBucket;
    let existingQuery;
    let updateQuery;

    beforeEach(() => {
        storageBucket = {
            upload: jest.fn().mockResolvedValue({ error: null }),
            getPublicUrl: jest.fn((path) => ({
                data: {
                    publicUrl:
                        `https://example.com/storage/v1/object/public/project-images/${path}`
                }
            })),
            remove: jest.fn().mockResolvedValue({ error: null })
        };

        db = {
            from: jest.fn(),
            storage: {
                from: jest.fn().mockReturnValue(storageBucket)
            }
        };

        existingQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: {
                    id: 1,
                    logo_url:
                        'https://example.com/storage/v1/object/public/project-images/old-logo.png',
                    cover_url:
                        'https://example.com/storage/v1/object/public/project-images/old-cover.png'
                },
                error: null
            })
        };

        updateQuery = {
            update: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: { id: 1 },
                error: null
            })
        };

        db.from
            .mockReturnValueOnce(existingQuery)
            .mockReturnValueOnce(updateQuery);

        controller = new CompanyController(db);
    });

    test('should replace the old company logo and remove the previous logo', async () => {
        const logoFile = {
            name: 'new-logo.png',
            type: 'image/png'
        };

        await controller.saveCompany(
            'designer-123',
            { name: 'Updated Company' },
            logoFile,
            null
        );

        expect(storageBucket.upload).toHaveBeenCalledTimes(1);

        expect(storageBucket.remove).toHaveBeenCalledWith([
            'old-logo.png'
        ]);

        expect(storageBucket.remove).not.toHaveBeenCalledWith([
            'old-cover.png'
        ]);

        expect(updateQuery.update).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Updated Company',
                logo_url: expect.stringContaining('logo-')
            })
        );
    });

    test('should replace the old company cover and remove the previous cover', async () => {
        const coverFile = {
            name: 'new-cover.jpg',
            type: 'image/jpeg'
        };

        await controller.saveCompany(
            'designer-123',
            { name: 'Updated Company' },
            null,
            coverFile
        );

        expect(storageBucket.upload).toHaveBeenCalledTimes(1);

        expect(storageBucket.remove).toHaveBeenCalledWith([
            'old-cover.png'
        ]);

        expect(storageBucket.remove).not.toHaveBeenCalledWith([
            'old-logo.png'
        ]);

        expect(updateQuery.update).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Updated Company',
                cover_url: expect.stringContaining('cover-')
            })
        );
    });

    test('should preserve existing images when no replacements are uploaded', async () => {
        await controller.saveCompany(
            'designer-123',
            { name: 'Updated Company' },
            null,
            null
        );

        expect(storageBucket.upload).not.toHaveBeenCalled();
        expect(storageBucket.remove).not.toHaveBeenCalled();

        expect(updateQuery.update).toHaveBeenCalledWith({
            name: 'Updated Company'
        });
    });
});


//Company Image Failure Handling
describe('Company Information - Image Failure Handling', () => {
    let db;
    let controller;
    let storageBucket;
    let existingQuery;
    let updateQuery;

    beforeEach(() => {
        storageBucket = {
            upload: jest.fn(),
            getPublicUrl: jest.fn((path) => ({
                data: {
                    publicUrl:
                        `https://example.com/storage/v1/object/public/project-images/${path}`
                }
            })),
            remove: jest.fn().mockResolvedValue({ error: null })
        };

        db = {
            from: jest.fn(),
            storage: {
                from: jest.fn().mockReturnValue(storageBucket)
            }
        };

        existingQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: {
                    id: 1,
                    logo_url: 'https://example.com/old-logo.png',
                    cover_url: 'https://example.com/old-cover.png'
                },
                error: null
            })
        };

        updateQuery = {
            update: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn()
        };

        db.from
            .mockReturnValueOnce(existingQuery)
            .mockReturnValueOnce(updateQuery);

        controller = new CompanyController(db);
    });

    test('should remove newly uploaded images when database saving fails', async () => {
        storageBucket.upload.mockResolvedValue({
            error: null
        });

        updateQuery.single.mockResolvedValue({
            data: null,
            error: new Error('Database save failed')
        });

        await expect(
            controller.saveCompany(
                'designer-123',
                { name: 'Updated Company' },
                { name: 'new-logo.png', type: 'image/png' },
                { name: 'new-cover.jpg', type: 'image/jpeg' }
            )
        ).rejects.toThrow('Database save failed');

        expect(storageBucket.upload).toHaveBeenCalledTimes(2);
        expect(storageBucket.remove).toHaveBeenCalledTimes(2);
    });

    test('should remove the uploaded logo when cover upload fails', async () => {
        storageBucket.upload
            .mockResolvedValueOnce({ error: null })
            .mockResolvedValueOnce({
                error: new Error('Cover upload failed')
            });

        await expect(
            controller.saveCompany(
                'designer-123',
                { name: 'Updated Company' },
                { name: 'new-logo.png', type: 'image/png' },
                { name: 'new-cover.jpg', type: 'image/jpeg' }
            )
        ).rejects.toThrow('Cover upload failed');

        expect(storageBucket.upload).toHaveBeenCalledTimes(2);
        expect(storageBucket.remove).toHaveBeenCalledTimes(1);
    });

    test('should report an error when newly uploaded images cannot be cleaned up', async () => {
        storageBucket.upload.mockResolvedValue({
            error: null
        });

        updateQuery.single.mockResolvedValue({
            data: null,
            error: new Error('Database save failed')
        });

        storageBucket.remove.mockResolvedValue({
            error: {
                message: 'Storage cleanup failed'
            }
        });

        await expect(
            controller.saveCompany(
                'designer-123',
                { name: 'Updated Company' },
                { name: 'new-logo.png', type: 'image/png' },
                null
            )
        ).rejects.toThrow(
            'Database save failed The project image could not be removed: Storage cleanup failed'
        );

        expect(storageBucket.remove).toHaveBeenCalledTimes(1);
    });
});
