<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Importazione di un modpack di tModLoader: dalla cartella Mods/ModPacks del server (name)
 * oppure caricando il .json del pack o la sua cartella compressa in .zip (file).
 */
class ImportModpackRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'name' => ['required_without:file', 'prohibits:file', 'string', 'max:255'],
            // 1 GB (in KB): il limite di upload di PHP è 1100M
            'file' => ['required_without:name', 'file', 'extensions:json,zip', 'max:1048576'],
            'replaceExisting' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'file.extensions' => 'Carica il .json del modpack oppure la sua cartella compressa in .zip.',
            'file.uploaded' => 'Caricamento fallito: il file supera il limite consentito dal server.',
        ];
    }
}
