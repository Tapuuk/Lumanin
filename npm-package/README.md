# lumanin

This is the plugin API of [Lumanin](https://github.com/Tapuuk/Lumanin), a keyboard-first
launcher for Linux.

**You never need to install this package.** The launcher itself provides the real module at
runtime: a plugin writes

```tsx
import { List, showToast } from 'lumanin'
```

and Lumanin answers that import with its own implementation. This npm package exists to hold the name and to fail loudly if it is ever installed by accident, so that the name can never resolve to someone else's code.

Want to write a plugin? See the repository - it ships a generator and a full API reference.
