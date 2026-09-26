def strip_nullable_unions(schema, *, keep_nullable_hint=True):
    def rewrite(value):
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if not isinstance(value, dict):
            return value
        out = {key: rewrite(item) for key, item in value.items()}
        for key in ('anyOf', 'oneOf'):
            variants = out.get(key)
            if not isinstance(variants, list):
                continue
            non_null = [item for item in variants if not isinstance(item, dict) or item.get('type') != 'null']
            if len(non_null) != 1 or len(non_null) == len(variants):
                continue
            replacement = dict(non_null[0]) if isinstance(non_null[0], dict) else {}
            if keep_nullable_hint:
                replacement.setdefault('nullable', True)
            for meta in ('title', 'description', 'default', 'examples'):
                if meta in out and meta not in replacement and not (meta == 'default' and '$ref' in replacement):
                    replacement[meta] = out[meta]
            return rewrite(replacement)
        return out
    return rewrite(schema)
