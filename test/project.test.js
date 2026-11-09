
const ProjectController = require('../project');

//Create Project
describe('Project Management - Create Project', () => {
    let db;
    let controller;

    beforeEach(() => {
        db = {
            from: jest.fn().mockReturnThis(),
            insert: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn()
        };

        controller = new ProjectController(db);
    });

    test('should create a project successfully', async () => {
        const projectData = {
            id: 1,
            designer_id: 'designer-123',
            title: 'Modern Living Room',
            description: 'A modern living room design',
            category_id: 2,
            budget: 5000,
            stage: 'completed',
            progress: 100,
            visibility: 'published'
        };

        db.single.mockResolvedValue({
            data: projectData,
            error: null
        });

        const result = await controller.createProject({
            designer_id: 'designer-123',
            title: 'Modern Living Room',
            description: 'A modern living room design',
            category_id: 2,
            budget: '5000'
        });

        expect(db.from).toHaveBeenCalledWith('projects');

        expect(db.insert).toHaveBeenCalledWith({
            designer_id: 'designer-123',
            title: 'Modern Living Room',
            description: 'A modern living room design',
            category_id: 2,
            budget: 5000,
            stage: 'completed',
            progress: 100,
            visibility: 'published'
        });

        expect(result).toEqual(projectData);
    });

    test('should use default values when optional fields are empty', async () => {
        db.single.mockResolvedValue({
            data: { id: 2, title: 'Bedroom Design' },
            error: null
        });

        await controller.createProject({
            designer_id: 'designer-123',
            title: 'Bedroom Design',
            budget: ''
        });

        expect(db.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                description: null,
                category_id: null,
                budget: null,
                stage: 'completed',
                progress: 100,
                visibility: 'published'
            })
        );
    });

    test('should return an error when project creation fails', async () => {
        const databaseError = new Error('Unable to create project');

        db.single.mockResolvedValue({
            data: null,
            error: databaseError
        });

        await expect(
            controller.createProject({
                designer_id: 'designer-123',
                title: 'Failed Project'
            })
        ).rejects.toThrow('Unable to create project');
    });
});


//Create Project with Images
describe('Project Management - Create Project with Image', () => {
    let db;
    let controller;
    let storageBucket;

    beforeEach(() => {
        storageBucket = {
            upload: jest.fn(),
            getPublicUrl: jest.fn()
        };

        db = {
            from: jest.fn().mockReturnThis(),
            insert: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn(),

            storage: {
                from: jest.fn().mockReturnValue(storageBucket)
            }
        };

        controller = new ProjectController(db);
    });

    test('should create a project with an uploaded image successfully', async () => {
        const imageFile = {
            name: 'living-room.png',
            type: 'image/png'
        };

        const projectData = {
            id: 1,
            title: 'Modern Living Room',
            designer_id: 'designer-123',
            image_url: 'https://example.com/project-image.png'
        };

        storageBucket.upload.mockResolvedValue({
            error: null
        });

        storageBucket.getPublicUrl.mockReturnValue({
            data: {
                publicUrl: 'https://example.com/project-image.png'
            }
        });

        db.single.mockResolvedValue({
            data: projectData,
            error: null
        });

        const result = await controller.createProject(
            {
                designer_id: 'designer-123',
                title: 'Modern Living Room'
            },
            imageFile
        );

        expect(storageBucket.upload).toHaveBeenCalled();

        expect(db.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                designer_id: 'designer-123',
                title: 'Modern Living Room',
                image_url: 'https://example.com/project-image.png'
            })
        );

        expect(result).toEqual(projectData);
    });

    test('should not create a project when image upload fails', async () => {
        storageBucket.upload.mockResolvedValue({
            error: new Error('Image upload failed')
        });

        await expect(
            controller.createProject(
                {
                    designer_id: 'designer-123',
                    title: 'Modern Living Room'
                },
                {
                    name: 'living-room.png',
                    type: 'image/png'
                }
            )
        ).rejects.toThrow('Image upload failed');

        expect(db.from).not.toHaveBeenCalled();
    });
});


//Retrieve Project for Editing
describe('Project Management - Edit Project', () => {
    let db;
    let controller;

    beforeEach(() => {
        db = {
            from: jest.fn(),
            select: jest.fn(),
            eq: jest.fn(),
            single: jest.fn(),
            maybeSingle: jest.fn()
        };

        controller = new ProjectController(db);
    });

    test('should retrieve an existing project without a draft', async () => {
        const projectData = {
            id: 1,
            designer_id: 'designer-123',
            title: 'Modern Living Room'
        };

        const projectQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: projectData,
                error: null
            })
        };

        const draftQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: null,
                error: null
            })
        };

        db.from.mockImplementation((table) => {
            return table === 'projects' ? projectQuery : draftQuery;
        });

        const result = await controller.editProject(1, 'designer-123');

        expect(result.project).toEqual(projectData);
        expect(result.draft).toBeNull();
    });

    test('should combine project details with saved draft details', async () => {
        const projectData = {
            id: 1,
            designer_id: 'designer-123',
            title: 'Old Project Title',
            description: 'Original description'
        };

        const draftData = {
            title: 'Updated Project Title',
            description: 'Updated description'
        };

        const projectQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: projectData,
                error: null
            })
        };

        const draftQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: draftData,
                error: null
            })
        };

        db.from.mockImplementation((table) => {
            return table === 'projects' ? projectQuery : draftQuery;
        });

        const result = await controller.editProject(1, 'designer-123');

        expect(result.project.title).toBe('Updated Project Title');
        expect(result.project.description).toBe('Updated description');
        expect(result.draft).toEqual(draftData);
    });

    test('should return an error when project retrieval fails', async () => {
        const databaseError = new Error('Unable to retrieve project');

        const projectQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: null,
                error: databaseError
            })
        };

        const draftQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: null,
                error: null
            })
        };

        db.from.mockImplementation((table) => {
            return table === 'projects' ? projectQuery : draftQuery;
        });

        await expect(
            controller.editProject(1, 'designer-123')
        ).rejects.toThrow('Unable to retrieve project');
    });
});


//Save as draft
describe('Project Management - Save Project Draft', () => {
    let db;
    let controller;

    beforeEach(() => {
        db = {
            from: jest.fn().mockReturnThis(),
            upsert: jest.fn()
        };

        controller = new ProjectController(db);
    });

    test('should save a project draft successfully', async () => {
        db.upsert.mockResolvedValue({
            data: { project_id: 1 },
            error: null
        });

        const fields = {
            title: 'Modern Bedroom',
            description: 'A modern bedroom design',
            budget: 8000
        };

        const result = await controller.saveProjectDraft(
            1,
            'designer-123',
            fields
        );

        expect(db.from).toHaveBeenCalledWith('project_drafts');

        expect(db.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                project_id: 1,
                designer_id: 'designer-123',
                title: 'Modern Bedroom',
                description: 'A modern bedroom design',
                budget: 8000
            }),
            { onConflict: 'project_id' }
        );

        expect(result).toEqual({ project_id: 1 });
    });

    test('should return an error when saving a project draft fails', async () => {
        const databaseError = new Error('Unable to save project draft');

        db.upsert.mockResolvedValue({
            data: null,
            error: databaseError
        });

        await expect(
            controller.saveProjectDraft(1, 'designer-123', {
                title: 'Modern Bedroom'
            })
        ).rejects.toThrow('Unable to save project draft');
    });
});


//Upload images (if needed)
describe('Project Management - Upload Project Image', () => {
    let db;
    let controller;
    let storageBucket;

    beforeEach(() => {
        storageBucket = {
            upload: jest.fn(),
            getPublicUrl: jest.fn()
        };

        db = {
            storage: {
                from: jest.fn().mockReturnValue(storageBucket)
            }
        };

        controller = new ProjectController(db);
    });

    test('should upload a project image successfully', async () => {
        const imageFile = {
            name: 'living room.png',
            type: 'image/png'
        };

        storageBucket.upload.mockResolvedValue({
            error: null
        });

        storageBucket.getPublicUrl.mockReturnValue({
            data: {
                publicUrl: 'https://example.com/project-image.png'
            }
        });

        const result = await controller.uploadProjectImage(
            'designer-123',
            imageFile
        );

        expect(db.storage.from).toHaveBeenCalledWith('project-images');

        expect(storageBucket.upload).toHaveBeenCalledWith(
            expect.stringMatching(
                /^projects\/designer-123\/\d+-living_room\.png$/
            ),
            imageFile,
            expect.objectContaining({
                cacheControl: '3600',
                upsert: false,
                contentType: 'image/png'
            })
        );

        expect(result).toBe(
            'https://example.com/project-image.png'
        );
    });

    test('should use the default content type when image type is missing', async () => {
        const imageFile = {
            name: 'design-image.png',
            type: ''
        };

        storageBucket.upload.mockResolvedValue({
            error: null
        });

        storageBucket.getPublicUrl.mockReturnValue({
            data: {
                publicUrl: 'https://example.com/design-image.png'
            }
        });

        await controller.uploadProjectImage(
            'designer-123',
            imageFile
        );

        expect(storageBucket.upload).toHaveBeenCalledWith(
            expect.any(String),
            imageFile,
            expect.objectContaining({
                contentType: 'application/octet-stream'
            })
        );
    });

    test('should return an error when project image upload fails', async () => {
        const uploadError = new Error('Project image upload failed');

        storageBucket.upload.mockResolvedValue({
            error: uploadError
        });

        await expect(
            controller.uploadProjectImage(
                'designer-123',
                {
                    name: 'design.png',
                    type: 'image/png'
                }
            )
        ).rejects.toThrow('Project image upload failed');
    });
});


//Remove image
describe('Project Management - Remove Project Image', () => {
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

        controller = new ProjectController(db);
    });

    test('should remove an existing project image successfully', async () => {
        storageBucket.remove.mockResolvedValue({
            error: null
        });

        const imageUrl =
            'https://example.com/storage/v1/object/public/project-images/projects/designer-123/image.png';

        const result = await controller.removeProjectImage(imageUrl);

        expect(db.storage.from).toHaveBeenCalledWith('project-images');

        expect(storageBucket.remove).toHaveBeenCalledWith([
            'projects/designer-123/image.png'
        ]);

        expect(result).toBeNull();
    });

    test('should return null when image URL is empty', async () => {
        const result = await controller.removeProjectImage(null);

        expect(result).toBeNull();
        expect(db.storage.from).not.toHaveBeenCalled();
    });

    test('should ignore an image URL outside the project-images bucket', async () => {
        const imageUrl = 'https://example.com/images/project.png';

        const result = await controller.removeProjectImage(imageUrl);

        expect(result).toBeNull();
        expect(db.storage.from).not.toHaveBeenCalled();
    });

    test('should decode special characters in the image path', async () => {
        storageBucket.remove.mockResolvedValue({
            error: null
        });

        const imageUrl =
            'https://example.com/storage/v1/object/public/project-images/projects/designer-123/living%20room.png';

        await controller.removeProjectImage(imageUrl);

        expect(storageBucket.remove).toHaveBeenCalledWith([
            'projects/designer-123/living room.png'
        ]);
    });

    test('should return an error message when image removal fails', async () => {
        storageBucket.remove.mockResolvedValue({
            error: {
                message: 'Unable to delete image'
            }
        });

        const imageUrl =
            'https://example.com/storage/v1/object/public/project-images/projects/designer-123/image.png';

        const result = await controller.removeProjectImage(imageUrl);

        expect(result).toBe(
            'The project image could not be removed: Unable to delete image'
        );
    });
});


//Save Changes
describe('Project Management - Save Project Changes', () => {
    let db;
    let controller;
    let projectQuery;

    beforeEach(() => {
        projectQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn()
        };

        db = {
            from: jest.fn()
        };

        controller = new ProjectController(db);
    });

    test('should update project details and delete its saved draft', async () => {
        projectQuery.single.mockResolvedValue({
            data: { image_url: 'old-image.jpg' },
            error: null
        });

        const updatedProject = {
            update: jest.fn().mockReturnThis(),
            eq: jest.fn()
        };

        updatedProject.eq.mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({
                data: null,
                error: null
            })
        }));

        const deletedDraft = {
            delete: jest.fn().mockReturnThis(),
            eq: jest.fn()
        };

        deletedDraft.eq.mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({
                data: null,
                error: null
            })
        }));

        let projectCalls = 0;

        db.from.mockImplementation((table) => {
            if (table === 'projects') {
                projectCalls++;

                return projectCalls === 1
                    ? projectQuery
                    : updatedProject;
            }

            return deletedDraft;
        });

        const result = await controller.saveProjectChanges(
            1,
            'designer-123',
            { title: 'Updated Living Room' }
        );

        expect(result).toBeNull();

        expect(updatedProject.update).toHaveBeenCalledWith({
            title: 'Updated Living Room'
        });

        expect(deletedDraft.delete).toHaveBeenCalled();
    });

    test('should return an error when updating the project fails', async () => {
        const databaseError = new Error('Unable to update project');

        projectQuery.single.mockResolvedValue({
            data: { image_url: 'old-image.jpg' },
            error: null
        });

        const failingQuery = {
            update: jest.fn().mockReturnThis(),
            eq: jest.fn()
        };

        failingQuery.eq.mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({
                error: databaseError
            })
        }));

        let projectCalls = 0;

        db.from.mockImplementation((table) => {
            if (table === 'projects') {
                projectCalls++;

                return projectCalls === 1
                    ? projectQuery
                    : failingQuery;
            }

            return {
                delete: jest.fn().mockReturnThis(),
                eq: jest.fn().mockReturnThis()
            };
        });

        await expect(
            controller.saveProjectChanges(1, 'designer-123', {
                title: 'Failed Update'
            })
        ).rejects.toThrow('Unable to update project');
    });

    test('should return a warning when deleting the saved draft fails', async () => {
        const draftError = new Error('Unable to delete draft');

        projectQuery.single.mockResolvedValue({
            data: { image_url: 'old-image.jpg' },
            error: null
        });

        let projectCalls = 0;

        db.from.mockImplementation((table) => {
            if (table === 'projects') {
                projectCalls++;

                if (projectCalls === 1) {
                    return projectQuery;
                }

                const query = {
                    update: jest.fn().mockReturnThis(),
                    eq: jest.fn()
                };

                query.eq.mockImplementation(() => ({
                    eq: jest.fn().mockResolvedValue({
                        error: null
                    })
                }));

                return query;
            }

            const query = {
                delete: jest.fn().mockReturnThis(),
                eq: jest.fn()
            };

            query.eq.mockImplementation(() => ({
                eq: jest.fn().mockResolvedValue({
                    error: draftError
                })
            }));

            return query;
        });

        await expect(
            controller.saveProjectChanges(1, 'designer-123', {
                title: 'Updated Project'
            })
        ).rejects.toThrow(
            'Project changes were saved, but the saved draft could not be cleared: Unable to delete draft'
        );
    });
});


//Image Cleanup
describe('Project Management - Save Project Changes Image Cleanup', () => {
    let db;
    let controller;
    let projectQuery;
    let updateQuery;
    let draftQuery;

    const newImageUrl = 'https://example.com/new-image.png';
    const oldImageUrl = 'https://example.com/old-image.png';

    beforeEach(() => {
        projectQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: { image_url: oldImageUrl },
                error: null
            })
        };

        updateQuery = {
            update: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            error: null
        };

        draftQuery = {
            delete: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            error: null
        };

        db = {
            from: jest.fn()
                .mockReturnValueOnce(projectQuery)
                .mockReturnValueOnce(updateQuery)
                .mockReturnValueOnce(draftQuery)
        };

        controller = new ProjectController(db);

        jest.spyOn(controller, 'uploadProjectImage')
            .mockResolvedValue(newImageUrl);
    });

    test('should clean up the uploaded image when project update fails', async () => {
        const updateError = new Error('Project update failed');

        updateQuery.error = updateError;

        const removeImageSpy = jest.spyOn(controller, 'removeProjectImage')
            .mockResolvedValue(null);

        await expect(
            controller.saveProjectChanges(
                'project-1',
                'designer-123',
                { title: 'Updated Project' },
                { name: 'new-image.png', type: 'image/png' }
            )
        ).rejects.toBe(updateError);

        expect(removeImageSpy).toHaveBeenCalledWith(newImageUrl);
    });

    test('should return an error when uploaded image cleanup also fails', async () => {
        const updateError = new Error('Project update failed');

        updateQuery.error = updateError;

        jest.spyOn(controller, 'removeProjectImage')
            .mockResolvedValue('Unable to remove uploaded image');

        await expect(
            controller.saveProjectChanges(
                'project-1',
                'designer-123',
                { title: 'Updated Project' },
                { name: 'new-image.png', type: 'image/png' }
            )
        ).rejects.toThrow(
            'Project update failed The uploaded replacement image could not be cleaned up: Unable to remove uploaded image'
        );
    });

    test('should return a warning when the previous image cannot be removed', async () => {
        jest.spyOn(controller, 'removeProjectImage')
            .mockRejectedValue(new Error('Storage unavailable'));

        const result = await controller.saveProjectChanges(
            'project-1',
            'designer-123',
            { title: 'Updated Project' },
            { name: 'new-image.png', type: 'image/png' }
        );

        expect(result).toBe(
            'Project changes were saved, but the previous image could not be removed: Storage unavailable'
        );
    });
});
