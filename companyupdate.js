// Get company information
async companyForEdit(designerId) {
    const profile = must(await db.from('profiles').select('id, name').eq('id', designerId).single());
    const company = must(await db.from('companies').select('*').eq('designer_id', designerId).limit(1).maybeSingle());
    const categories = must(await db.from('categories').select('*').order('name'));
    return { profile, company, categories };
}

// Save company information
async saveCompany(designerId, fields, logoFile = null, coverFile = null) {
    const existing = must(await db.from('companies').select('id, logo_url, cover_url').eq('designer_id', designerId).limit(1).maybeSingle());

    const logoUrl = await this.uploadCompanyAsset(designerId, 'logo', logoFile);
    const coverUrl = await this.uploadCompanyAsset(designerId, 'cover', coverFile);

    const values = {...fields, ...(logoUrl ? { logo_url: logoUrl } : {}), ...(coverUrl ? { cover_url: coverUrl } : {})
    };

    const rows = existing? must(await db.from('companies').update(values).eq('id', existing.id).eq('designer_id', designerId).select('id'))
    : must(await db.from('companies').insert({ designer_id: designerId, ...values }).select('id'));

  // Delete replaced images
    const marker = '/storage/v1/object/public/project-images/';
    const replaced = [logoUrl && existing?.logo_url, coverUrl && existing?.cover_url];
    for (const oldUrl of replaced) {
        const i = oldUrl ? oldUrl.indexOf(marker) : -1;
        if (i >= 0) await db.storage.from('project-images').remove([decodeURIComponent(oldUrl.slice(i + marker.length))]);
    } 
}

async companyInformationView() {
    const designerId = this.designerDashboardUserId;
    const { profile, company, categories } = await this.designers.companyForEdit(designerId);
    const specialties = Array.isArray(company?.specialties) ? company.specialties : [];
    const designAreas = Array.isArray(company?.design_areas) ? company.design_areas : [];
    const areas = ['Living room', 'Bedroom', 'Kitchen', 'Bathroom', 'Home office', 'Outdoor'];
    const checkbox = (name, value, checked) => `
    <label class="designer-check">
    <input type="checkbox" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}>
    <span>${esc(value)}</span>
    </label>`;

 
async companyInformationView() {
    const designerId = this.designerDashboardUserId;

    if (!designerId) {
        throw new Error('No active interior designer is available to preview.');
    }

    const { profile, company, categories } =
        await this.designers.companyForEdit(designerId);

    const specialties = Array.isArray(company?.specialties)
        ? company.specialties
        : [];

    const designAreas = Array.isArray(company?.design_areas)
        ? company.design_areas
        : [];

    const areas = ['Living room', 'Bedroom', 'Kitchen', 'Bathroom', 'Home office', 'Outdoor'];

    const checkbox = (name, value, checked) => `
        <label class="designer-check">
            <input type="checkbox" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}>
            <span>${esc(value)}</span>
        </label>`;

    this.show(`
        <main class="designer-company-page">
        <header class="edit-company-heading">
        <section>
        <h1>Company profile</h1>
        <p>This is what customers see on your public company page.</p>
        </section>
        <button type="button" class="designer-outline-button" id="view-company--information">
        Company information
        </button>
        <button type="button" class="designer-outline-button" id="view-public-profile">
        Public profile
        </button>
        </header>

        <form id="edit-company-page">
        <section class="company-information-section">
        <h2>Branding</h2>
        <section class="designer-branding-box">
        <section class="designer-branding-logo">
        <h3>Logo</h3>
        ${company?.logo_url? `<img class="designer-brand-preview logo" src="${esc(company.logo_url)}" alt="Company logo">`
        : '<span class="designer-brand-placeholder"></span>'}
        <label for="company-logo" class="designer-outline-button">
        ${company?.logo_url ? 'Change logo' : 'Add logo'}
        </label>
        <input id="company-logo" class="edit-company-logo" type="file" name="logo" accept="image/*">
        </section>
        <section class="designer-branding-cover">
        <h3>Cover photo</h3>
        <label for="company-cover" class="designer-cover-drop">
        ${company?.cover_url? `<img class="designer-brand-preview cover" src="${esc(company.cover_url)}" alt="Company cover photo">`
        : '<span>Upload a cover photo</span>'}
        <input id="company-cover" class="edit-company-cover" type="file" name="cover" accept="image/*">
        </label>
        </section>
        </section>
        </section>
        
        <section class="company-information-section">
        <h2>Company information</h2>
        <section class="company-information-box">
        <label>Company name
        <input type="text" name="name" maxlength="120" value="${esc(company?.name ?? profile.name)}" required>
        </label>
        <label>Year established
        <input type="number" name="year_established" min="1800" max="${new Date().getFullYear()}"
        value="${esc(company?.year_established ?? '')}" placeholder="[year]">
        </label>
        <label class="company-information-label">Tagline
        <input type="text" name="tagline" maxlength="160" value="${esc(company?.tagline ?? '')}" placeholder="[Short tagline]">
        </label>
        <label class="company-information-label">About the company
        <textarea name="AboutCompanyArea" rows="5" maxlength="2000">${esc(company?.bio ?? '')}</textarea>
        </label>
        <section class="company-information-label">
        <h3>Specialties</h3>
        <section class="designer-check-list">
        ${categories.map(c => checkbox('specialties', c.name, specialties.includes(c.name))).join('')
            || '<span class="muted">Add categories to select specialties.</span>'}
            </section>
            </section>
            </section>
            </section>
            
            <section class="company-servicesoffered-section">
            <h2>Services Offered</h2>
            <label>
            Services offered (one per line)
            <textarea name="companyservices" rows="4" maxlength="2000">${esc(company?.services ?? '')}</textarea>
            </label>
            <section>
            <h3>Areas of design</h3>
            <section class="area-of-design-check-list">
            ${areas.map(a => checkbox('design_areas', a, designAreas.includes(a))).join('')}
            </section>
            </section>
            </section>
            
            <section class="company-contact-section">
            <h2>Contact details</h2>
            <section class="company-contact-box">
            <label>Email
            <input type="email" name="email"
            value="${esc(company?.email ?? (this.isReadOnlyPreview ? '' : this.user.email ?? ''))}">
            </label>
            <label>Phone
            <input type="tel" name="phone" maxlength="40" value="${esc(company?.phone ?? '')}">
            </label>
            <label>Website
            <input type="url" name="website" maxlength="300" value="${esc(company?.website ?? '')}" placeholder="https://">
            </label>
            <label>Address
            <input type="text" name="address" maxlength="300" value="${esc(company?.address ?? '')}">
            </label>
            </section>
            </section>

            <div class="company-edit-actions">
            <button type="button" class="btn secondary-btn" 
            id="discard-company-changes">Discard changes</button>

            <button type="submit" class="btn designer-save-button"
            name="save-company-changes" value="save">Save changes</button>
            </div>
            </form>
            </main>
    `);


    const form = this.$('#edit-company-form');

    this.$('#view-public-profile').onclick = () => this.designerView(profile.id);

    this.$('#discard-company-changes').onclick = () => this.companyInformationView();

    form.onsubmit = this.guard(async () => {
        const data = new FormData(form);
        const text = key => String(data.get(key) ?? '').trim() || null;
        const name = text('name');
        if (!name) {
            throw new Error('Company name is required.');
        }
        const year = text('year_established');
        const yearEstablished = year ? Number(year) : null;
        if (yearEstablished !== null &&
            (!Number.isInteger(yearEstablished) || yearEstablished < 1800 || yearEstablished > new Date().getFullYear())) {
            throw new Error('Enter a valid year established.');
        }
        await this.designers.saveCompany(designerId, {
            name,
            year_established: yearEstablished,
            tagline: text('tagline'),
            bio: text('bio'),
            specialties: data.getAll('specialties'),
            services: text('services'),
            design_areas: data.getAll('design_areas'),
            email: text('email'),
            phone: text('phone'),
            website: text('website'),
            address: text('address')
        }, form.elements.namedItem('logo').files[0] ?? null,
           form.elements.namedItem('cover').files[0] ?? null);

        await this.companyInformationView();
    });
}
}
