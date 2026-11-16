<?php

namespace App\Console\Commands;

use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Copia tutti i dati da un altro database (es. il vecchio MariaDB) a quello attuale (es. SQLite).
 * Il database di destinazione deve avere già lo schema: prima `php artisan migrate`.
 */
#[Signature('db:import-from {connection : Connessione di origine (es. mariadb)} {--force : Svuota le tabelle di destinazione anche se contengono dati}')]
#[Description('Copia i dati da un\'altra connessione al database attuale (es. da MariaDB a SQLite)')]
class ImportDatabase extends Command
{
    /** Tabelle che non ha senso copiare: si rigenerano da sole. */
    private const SKIP = ['migrations', 'cache', 'cache_locks', 'jobs', 'job_batches', 'failed_jobs'];

    public function handle(): int
    {
        $from = DB::connection($this->argument('connection'));
        $to = DB::connection();

        if ($from->getName() === $to->getName()) {
            $this->components->error('La connessione di origine è quella attuale.');

            return self::FAILURE;
        }

        $tables = collect(Schema::connection($from->getName())->getTableListing(schemaQualified: false))
            ->reject(fn (string $table): bool => in_array($table, self::SKIP, true))
            ->filter(fn (string $table): bool => Schema::hasTable($table))
            ->values();

        $notEmpty = $tables->filter(fn (string $table): bool => $to->table($table)->exists());
        if ($notEmpty->isNotEmpty() && ! $this->option('force')) {
            $this->components->error('Tabelle di destinazione non vuote: '.$notEmpty->implode(', ').'. Usa --force per sovrascriverle.');

            return self::FAILURE;
        }

        Schema::withoutForeignKeyConstraints(function () use ($tables, $from, $to): void {
            $to->transaction(function () use ($tables, $from, $to): void {
                foreach ($tables as $table) {
                    $to->table($table)->delete();
                    $count = 0;
                    $columns = Schema::getColumnListing($table);
                    $from->table($table)->orderBy($from->raw('1'))->chunk(500, function ($rows) use ($to, $table, $columns, &$count): void {
                        $to->table($table)->insert($rows->map(fn ($row): array => array_intersect_key((array) $row, array_flip($columns)))->all());
                        $count += $rows->count();
                    });
                    $this->components->twoColumnDetail($table, (string) $count);
                }
            });
        });

        $this->components->info('Dati copiati.');

        return self::SUCCESS;
    }
}
