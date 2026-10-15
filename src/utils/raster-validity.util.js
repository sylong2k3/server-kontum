'use strict';
const fs = require('fs');
function validityError(message) {
    const error = new Error(message); error.code = 'RASTER_VALIDITY_UNSUPPORTED'; return error;
}
async function rasterValidity(tiff, image, filePath) {
    const directory = image.getFileDirectory();
    const tag = name => directory.hasTag(name) ? directory.getValue(name) : null;
    if (tag('SubIFDs')?.length || tag('ExtraSamples')?.some(v => v === 1 || v === 2) || fs.existsSync(`${filePath}.msk`)) {
        throw validityError('SubIFD, alpha or external validity mask is not supported by this statistics reader.');
    }
    const noData = image.getGDALNoData();
    const datasetMetadata = await image.getGDALMetadata();
    if (datasetMetadata?.NODATA_VALUES != null) throw validityError('Tuple NODATA_VALUES requires a separate validity policy.');
    const perBand = [];
    for (let b = 0; b < image.getSamplesPerPixel(); b++) {
        const metadata = await image.getGDALMetadata(b);
        if (metadata && Object.keys(metadata).some(key => /nodata/i.test(key))) {
            throw validityError('Per-sample NoData metadata is not supported; it must not be ignored.');
        }
        perBand.push(noData);
    }
    let mask = null;
    const count = await tiff.getImageCount();
    for (let i = 1; i < count; i++) {
        const candidate = await tiff.getImage(i);
        const fd = candidate.getFileDirectory();
        const type = fd.hasTag('NewSubfileType') ? fd.getValue('NewSubfileType') : 0;
        if (!(type & 4)) continue;
        if (candidate.getWidth() !== image.getWidth() || candidate.getHeight() !== image.getHeight()) {
            if (type & 1) continue; // Reduced-resolution mask is not the analytical grid.
            throw validityError('Internal mask dimensions differ from the analytical raster.');
        }
        if (mask || candidate.getSamplesPerPixel() !== 1) throw validityError('Ambiguous internal validity masks.');
        [mask] = await candidate.readRasters({ samples: [0] });
    }
    return band => (value, index) => Number.isFinite(value)
        && (perBand[band] == null || Number.isNaN(perBand[band]) || value !== perBand[band])
        && (!mask || mask[index] !== 0);
}
module.exports = { rasterValidity, validityError };
