/* Decode every hunk of a CHD with libchdr and write the logical data to stdout,
 * so its SHA-1 can be compared with the "Data SHA1" chdman recorded at creation. */
#include <libchdr/chd.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(int argc, char **argv)
{
	chd_file *chd = NULL;
	if (argc < 2) { fprintf(stderr, "usage: chdread file.chd > data\n"); return 1; }
	chd_error err = chd_open(argv[1], CHD_OPEN_READ, NULL, &chd);
	if (err != CHDERR_NONE) { fprintf(stderr, "open: %s\n", chd_error_string(err)); return 1; }
	const chd_header *h = chd_get_header(chd);
	unsigned char *buf = malloc(h->hunkbytes);
	unsigned long long left = h->logicalbytes;
	clock_t t0 = clock();
	for (unsigned int i = 0; i < h->totalhunks && left; i++)
	{
		err = chd_read(chd, i, buf);
		if (err != CHDERR_NONE) { fprintf(stderr, "hunk %u: %s\n", i, chd_error_string(err)); return 2; }
		size_t n = left < h->hunkbytes ? (size_t)left : h->hunkbytes;
		fwrite(buf, 1, n, stdout);
		left -= n;
	}
	fprintf(stderr, "libchdr: %u hunks of %u bytes decoded in %.2f s CPU\n", h->totalhunks, h->hunkbytes, (double)(clock() - t0) / CLOCKS_PER_SEC);
	chd_close(chd);
	return 0;
}
