# Publishing `lumanin` to the AUR

The AUR hosts the `PKGBUILD`, not the package: every user's `yay -S lumanin` downloads the
release tarball and the Electron zip from GitHub and builds locally. So publishing is pushing
three small files to a git repository that the AUR owns. Done once for the first release, then
repeated per version.

## Once: an AUR account and an SSH key

1. Create an account at <https://aur.archlinux.org/register>.
2. Generate a key for it (a separate one keeps the AUR's access narrow):

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/aur -C "aur"
   ```

3. Paste `~/.ssh/aur.pub` into *My Account* → *SSH Public Key* on the AUR site.
4. Tell ssh to use it for the AUR host:

   ```
   # ~/.ssh/config
   Host aur.archlinux.org
     IdentityFile ~/.ssh/aur
     User aur
   ```

5. Check: `ssh aur@aur.archlinux.org` should answer with a greeting naming your account.

## Once: claim the package name

Cloning a repository that does not exist yet creates it on first push:

```bash
git clone ssh://aur@aur.archlinux.org/lumanin.git ~/aur/lumanin
```

It warns "You appear to have cloned an empty repository" - that is the claim.

## Per release

Do this after the GitHub tag exists, because the tarball checksum is per tag.

```bash
cd packaging/aur
# 1. the version this release is
sed -i 's/^pkgver=.*/pkgver=1.0.0/; s/^pkgrel=.*/pkgrel=1/' PKGBUILD
# 2. real checksums: downloads the tarball and both Electron zips, rewrites the sha256 lines
updpkgsums
# 3. prove it builds, on this machine
makepkg -f --cleanbuild        # add -d if your node is not pacman's (skips the dependency check)
# 4. the metadata file the AUR indexes
makepkg --printsrcinfo > .SRCINFO
# 5. publish
cp PKGBUILD .SRCINFO lumanin.install ~/aur/lumanin/
cd ~/aur/lumanin
git add PKGBUILD .SRCINFO lumanin.install
git commit -m "Update to 1.0.0"
git push
```

Then commit the updated `PKGBUILD` and `.SRCINFO` back into this repository too, so the two
never disagree.

Notes:

- The AUR accepts only these three files (plus optional patches). No `release/`, no built
  packages, no `src/`.
- `pkgrel` resets to 1 on a new `pkgver`; bump it alone when only the PKGBUILD changed.
- `.SRCINFO` must match `PKGBUILD` exactly or the push is rejected; always regenerate it last.
- A bumped Electron means new zip checksums in *both* `PKGBUILD` (`updpkgsums` does it) and
  `scripts/package.sh` (`electron_sha256`, by hand).
- The first push makes the page <https://aur.archlinux.org/packages/lumanin> live within a
  minute. `yay -S lumanin` works from then on, on x86_64 and aarch64.
