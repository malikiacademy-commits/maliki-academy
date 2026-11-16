import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('backups',{recursive:true});
const file=resolve('backups/academy-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
const database=new DatabaseSync(process.env.DATABASE_PATH||'data/academy.sqlite');
database.prepare('VACUUM INTO ?').run(file);database.close();console.log(file);
