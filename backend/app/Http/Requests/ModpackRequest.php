<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

class ModpackRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:64'],
            'description' => ['nullable', 'string', 'max:500'],
            'mods' => ['present', 'array', 'max:500'],
            'mods.*' => ['string', 'distinct', 'regex:/^[A-Za-z0-9_]{1,64}$/'],
            // Mod → versione bloccata (le mod senza voce seguono gli aggiornamenti)
            'versions' => ['sometimes', 'array', 'max:500'],
            'versions.*' => ['string', 'regex:/^\d{1,9}(\.\d{1,9}){0,3}$/'],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            foreach (array_keys((array) $this->input('versions', [])) as $mod) {
                if (! is_string($mod) || ! preg_match('/^[A-Za-z0-9_]{1,64}$/', $mod)) {
                    $validator->errors()->add('versions', 'Nome mod non valido nelle versioni.');

                    return;
                }
            }
        });
    }

    /**
     * @return array{name: string, description: string, mods: list<string>, versions: array<string, string>|object}
     */
    public function payload(): array
    {
        $versions = (array) ($this->validated('versions') ?? []);

        return [
            'name' => trim($this->validated('name')),
            'description' => (string) $this->validated('description'),
            'mods' => array_values($this->validated('mods')),
            // Oggetto JSON anche quando è vuoto (un array PHP vuoto diventerebbe [])
            'versions' => $versions === [] ? (object) [] : $versions,
        ];
    }
}
