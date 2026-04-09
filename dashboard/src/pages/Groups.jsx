import React, { useState, useEffect } from 'react';
import { groupsAPI } from '../utils/api';
import { CATEGORY_COLORS } from '../utils/colors';

export default function Groups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    url: '',
    category: 'marque',
    interval: 15,
    enabled: true,
  });

  useEffect(() => {
    fetchGroups();
  }, []);

  const fetchGroups = async () => {
    try {
      setLoading(true);
      const response = await groupsAPI.getAll(true);
      setGroups(response.data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddGroup = async (e) => {
    e.preventDefault();
    try {
      await groupsAPI.create(formData);
      setFormData({ name: '', url: '', category: 'marque', interval: 15, enabled: true });
      setShowModal(false);
      fetchGroups();
    } catch (error) {
      console.error('Error adding group:', error);
    }
  };

  const handleToggleGroup = async (group) => {
    try {
      await groupsAPI.update(group.id, { enabled: !(group.enabled !== false) });
      fetchGroups();
    } catch (error) {
      console.error('Error toggling group:', error);
    }
  };

  const handleDeleteGroup = async (id) => {
    if (window.confirm('Confirmer la suppression du groupe ?')) {
      try {
        await groupsAPI.delete(id);
        fetchGroups();
      } catch (error) {
        console.error('Error deleting group:', error);
      }
    }
  };

  if (loading) {
    return <div style={{ padding: '40px', textAlign: 'center' }}>Chargement...</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Groupes Facebook</h2>
          <p style={{ fontSize: '13px', color: 'var(--text2)', marginTop: '3px' }}>
            {groups.filter((group) => group.enabled !== false).length} groupe{groups.length !== 1 ? 's' : ''} actif{groups.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          Ajouter un groupe
        </button>
      </div>

      <div className="grid-3">
        {groups.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text2)' }}>
            Aucun groupe
          </div>
        ) : (
          groups.map((group) => {
            const categoryColor = CATEGORY_COLORS[group.category] || CATEGORY_COLORS.marque;
            return (
              <div key={group.id} className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <h3 style={{ fontSize: '14px', fontWeight: 600 }}>{group.name}</h3>
                    <span className="badge" style={{ background: categoryColor.background, color: 'white', marginTop: '8px' }}>
                      {categoryColor.label}
                    </span>
                    <span
                      className="badge"
                      style={{
                        marginTop: '8px',
                        marginLeft: '8px',
                        background: group.enabled !== false ? '#16a34a' : '#64748b',
                        color: '#fff',
                      }}
                    >
                      {group.enabled !== false ? 'Actif' : 'Pause'}
                    </span>
                  </div>
                  <button className="delete-btn" onClick={() => handleDeleteGroup(group.id)}>
                    ✕
                  </button>
                </div>
                <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text2)' }}>
                  <div>URL: {group.group_url || group.url || 'n/a'}</div>
                  <div>Intervalle: {group.scan_interval_minutes || group.interval || 15} min</div>
                </div>
                <div style={{ marginTop: '10px' }}>
                  <button className="btn-secondary" onClick={() => handleToggleGroup(group)}>
                    {group.enabled !== false ? 'Mettre en pause' : 'Activer'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {showModal && (
        <div className="modal-overlay open">
          <div className="modal">
            <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            <h2>Ajouter un groupe</h2>
            <p className="modal-sub">Configurez un nouveau groupe à surveiller</p>

            <form onSubmit={handleAddGroup}>
              <div className="form-field">
                <label>Nom du groupe</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div className="form-field">
                <label>URL Facebook</label>
                <input
                  type="text"
                  value={formData.url}
                  onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                  required
                />
              </div>

              <div className="form-row">
                <div className="form-field">
                  <label>Catégorie</label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  >
                    <option value="marque">Marque</option>
                    <option value="services">Services</option>
                    <option value="produits">Produits</option>
                    <option value="negatif">Termes Négatifs</option>
                  </select>
                </div>

                <div className="form-field">
                  <label>Intervalle (min)</label>
                  <input
                    type="number"
                    value={formData.interval}
                    onChange={(e) => setFormData({ ...formData, interval: e.target.value })}
                    min="5"
                    max="180"
                  />
                </div>
              </div>

              <div className="form-field">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="checkbox"
                    checked={formData.enabled}
                    onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                  />
                  Activer ce groupe
                </label>
              </div>

              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>
                  Annuler
                </button>
                <button type="submit" className="btn-primary">
                  Créer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
