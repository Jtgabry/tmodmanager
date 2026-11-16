<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        /**
         * Copia locale dei dati delle pagine dello Steam Workshop, aggiornata ogni volta che
         * l'agent li chiede a Steam: vale per qualsiasi mod (installata o no, su qualsiasi server).
         */
        Schema::create('workshop_items', function (Blueprint $table) {
            $table->id();
            $table->string('workshop_id', 20)->unique();
            /** Nome interno della mod, quando Steam lo dichiara (solo con la chiave Web API). */
            $table->string('mod_name', 64)->nullable()->index();
            /** false: elemento rimosso, privato o non di tModLoader. */
            $table->boolean('found');
            $table->string('title')->nullable();
            $table->json('tags');
            $table->string('preview_url', 1000)->nullable();
            $table->unsignedInteger('subscriptions')->nullable();
            $table->unsignedBigInteger('file_size')->nullable();
            /** Ultimo aggiornamento della pagina nel Workshop. */
            $table->timestamp('workshop_updated_at')->nullable();
            /** Ultima volta che i dati sono arrivati da Steam. */
            $table->timestamp('fetched_at');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('workshop_items');
    }
};
