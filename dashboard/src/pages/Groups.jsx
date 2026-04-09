import React, { useState, useEffect } from 'react';
import { groupsAPI } from '../utils/api';
import { CATEGORY_COLORS } from '../utils/colors';

export default function Groups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', url: '', category: 'marque', interval: 15 });

  useEffect(() => {
    fetchGroups();
  }, []);

  const fetchGroups = async () => {
    try {
      setLoading(true);
      const response = await groupsAPI.getAll();
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
      setFormData({ name: '', url: '', category: 'marque', interval: 15 });
      setShowModal(false);
      fetchGroups();
    } catch (error) {
      console.error('Error adding group:', error);
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
            {groups.length} groupe{groups.length !== 1 ? 's' : ''} surveillé{groups.length !== 1 ? 's' : ''}
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
                  </div>
                  <button className="delete-btn" onClick={() => handleDeleteGroup(group.id)}>
                    ✕
                  </button>
                </div>
                <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text2)' }}>
                  <div>Posts: {group.post_count || 0}</div>
                  <div>Alertes: {group.alert_count || 0}</div>
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
