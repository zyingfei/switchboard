# bac.delete_annotation

Write tool. Soft-deletes an annotation by `bac_id`. The annotation file and
revision history remain in `_BAC/annotations/`; list calls hide it unless the
companion endpoint is queried with `includeDeleted=true`.
